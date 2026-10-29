"""Read vehicle pings for one service day from the raw snapshot archive."""

import gzip
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
from google.transit import gtfs_realtime_pb2 as rt

from . import DATA_DIR, LOCAL_TZ, RAW_PREFIX

# Rough ZET service area (Zagreb, Velika Gorica, Zaprešić, Samobor); outside is junk.
BBOX = (15.55, 45.60, 16.35, 46.00)  # lon_min, lat_min, lon_max, lat_max
# Pings whose timestamp is this much older than the snapshot are ghosts of vehicles that stopped reporting.
MAX_STALENESS_S = 300

SCHEDULE_RELATIONSHIP = {v: k for k, v in rt.TripDescriptor.ScheduleRelationship.items()}


def _snapshot_paths(service_date):
    """Hourly UTC directories covering local service_date 00:00 to the next day 06:00."""
    tz = ZoneInfo(LOCAL_TZ)
    day = datetime.strptime(service_date, "%Y%m%d").replace(tzinfo=tz)
    start = day.astimezone(ZoneInfo("UTC"))
    end = (day + timedelta(hours=30)).astimezone(ZoneInfo("UTC"))
    hour = start.replace(minute=0, second=0, microsecond=0)
    while hour < end:
        directory = DATA_DIR / RAW_PREFIX / hour.strftime("%Y/%m/%d/%H")
        if directory.exists():
            yield from sorted(directory.glob("*.pb.gz"))
        hour += timedelta(hours=1)


def read_pings(service_date):
    """All vehicle pings whose trip runs on service_date, deduplicated on (vehicle, timestamp).

    Returns (pings, coverage) where coverage counts what was dropped and why.
    """
    rows = []
    snapshots = 0
    feed = rt.FeedMessage()
    for path in _snapshot_paths(service_date):
        feed.ParseFromString(gzip.decompress(path.read_bytes()))
        snapshots += 1
        poll_ts = int(datetime.strptime(path.name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=ZoneInfo("UTC")).timestamp())
        for entity in feed.entity:
            if not entity.HasField("vehicle"):
                continue
            v = entity.vehicle
            rows.append((
                poll_ts, v.vehicle.id, v.timestamp, v.trip.trip_id, v.trip.route_id, v.trip.start_date,
                SCHEDULE_RELATIONSHIP.get(v.trip.schedule_relationship, ""),
                v.position.latitude, v.position.longitude,
            ))
    cols = ["poll_ts", "vehicle_id", "ts", "trip_id", "route_id", "start_date", "schedule_relationship", "lat", "lon"]
    df = pd.DataFrame(rows, columns=cols)
    coverage = {"snapshots": snapshots, "pings_raw": len(df)}

    stale = df["poll_ts"] - df["ts"] > MAX_STALENESS_S
    coverage["pings_stale"] = int(stale.sum())
    df = df[~stale].drop_duplicates(["vehicle_id", "ts"])
    coverage["pings_unique"] = len(df)
    no_trip = df["trip_id"] == ""
    coverage["pings_no_trip"] = int(no_trip.sum())
    df = df[~no_trip & (df["start_date"] == service_date)]
    coverage["pings_service_day"] = len(df)

    lon_min, lat_min, lon_max, lat_max = BBOX
    inside = df["lon"].between(lon_min, lon_max) & df["lat"].between(lat_min, lat_max)
    coverage["pings_outside_area"] = int((~inside).sum())
    df = df[inside]
    canceled = df["schedule_relationship"] == "CANCELED"
    coverage["pings_canceled_trip"] = int(canceled.sum())
    df = df[~canceled]

    return df.sort_values(["trip_id", "vehicle_id", "ts"]).reset_index(drop=True), coverage
