"""Read vehicle pings for one service day from the raw snapshot archive."""

import gzip
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
from google.transit import gtfs_realtime_pb2 as rt

from . import LOCAL_TZ, RAW_PREFIX
from .store import get_many

# Rough ZET service area (Zagreb, Velika Gorica, Zaprešić, Samobor); outside is junk.
BBOX = (15.55, 45.60, 16.35, 46.00)  # lon_min, lat_min, lon_max, lat_max
# Pings whose timestamp is this much older than the snapshot are ghosts of vehicles that stopped reporting.
MAX_STALENESS_S = 300

CANCELED = rt.TripDescriptor.ScheduleRelationship.Value("CANCELED")
COLUMNS = ["poll_ts", "vehicle_id", "ts", "trip_id", "route_id", "start_date", "lat", "lon"]


def snapshot_keys(store, service_date):
    """Snapshot keys in the hourly UTC prefixes covering local service_date 00:00 to the next day 06:00."""
    tz = ZoneInfo(LOCAL_TZ)
    day = datetime.strptime(service_date, "%Y%m%d").replace(tzinfo=tz)
    start = day.astimezone(ZoneInfo("UTC"))
    end = (day + timedelta(hours=30)).astimezone(ZoneInfo("UTC"))
    hour = start.replace(minute=0, second=0, microsecond=0)
    keys = []
    while hour < end:
        keys.extend(k for k in store.list(f"{RAW_PREFIX}/{hour:%Y/%m/%d/%H}/") if k.endswith(".pb.gz"))
        hour += timedelta(hours=1)
    return keys


def read_pings(store, service_date):
    """All vehicle pings whose trip runs on service_date, deduplicated on (vehicle, timestamp).

    Filters while streaming so a full day fits in a small instance. Returns
    (pings, coverage) where coverage counts what was dropped and why.
    """
    cov = dict.fromkeys(["snapshots", "pings_raw", "pings_stale", "pings_unique", "pings_no_trip",
                         "pings_service_day", "pings_outside_area", "pings_canceled_trip"], 0)
    lon_min, lat_min, lon_max, lat_max = BBOX
    cols = {c: [] for c in COLUMNS}
    last_ts = {}   # vehicle -> newest timestamp kept; a vehicle repeats in snapshots until it reports again
    strings = {}   # one shared object per distinct id string
    s = lambda v: strings.setdefault(v, v)

    for key, body in get_many(store, snapshot_keys(store, service_date)):
        # A fresh message per snapshot: upb keeps every parse into a reused message
        # in its arena (~0.5 MB each, gigabytes over a day).
        feed = rt.FeedMessage()
        feed.ParseFromString(gzip.decompress(body))
        cov["snapshots"] += 1
        name = key.rsplit("/", 1)[-1]
        poll_ts = int(datetime.strptime(name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=ZoneInfo("UTC")).timestamp())
        for entity in feed.entity:
            if not entity.HasField("vehicle"):
                continue
            v = entity.vehicle
            cov["pings_raw"] += 1
            if poll_ts - v.timestamp > MAX_STALENESS_S:
                cov["pings_stale"] += 1
                continue
            vid = v.vehicle.id
            if v.timestamp <= last_ts.get(vid, -1):
                continue
            last_ts[vid] = v.timestamp
            cov["pings_unique"] += 1
            trip = v.trip
            if not trip.trip_id:
                cov["pings_no_trip"] += 1
                continue
            if trip.start_date != service_date:
                continue
            cov["pings_service_day"] += 1
            lat, lon = v.position.latitude, v.position.longitude
            if not (lon_min <= lon <= lon_max and lat_min <= lat <= lat_max):
                cov["pings_outside_area"] += 1
                continue
            if trip.schedule_relationship == CANCELED:
                cov["pings_canceled_trip"] += 1
                continue
            for c, val in zip(COLUMNS, (poll_ts, s(vid), v.timestamp, s(trip.trip_id), s(trip.route_id),
                                        s(trip.start_date), lat, lon)):
                cols[c].append(val)

    df = pd.DataFrame(cols)
    return df.sort_values(["trip_id", "vehicle_id", "ts"]).reset_index(drop=True), cov
