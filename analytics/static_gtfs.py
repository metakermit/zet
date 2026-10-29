"""Versioned static GTFS loader.

    python -m analytics.static_gtfs [--zip PATH | --url URL] [--force]

Writes data/gtfs/<feed_version>/ with the source zip and Parquet tables:
routes, trips (+ pattern_id), stops, shapes (EPSG:3765 WKB), stop_times,
pattern_stops (stop distance along shape) and segments (stop-to-stop).
"""

import argparse
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
import shapely.ops

from . import GTFS_DIR
from .geo import DenseShape, locate_stops_on_shape, to_metric, to_wgs84

DEFAULT_URL = "https://www.zet.hr/gtfs-scheduled/latest"


def _read(z, name, **kw):
    return pd.read_csv(z.open(name), dtype=str, keep_default_na=False, **kw)


def _gtfs_seconds(series):
    """'HH:MM:SS' (HH may exceed 23) to seconds since service-day noon - 12h."""
    parts = series.str.split(":", expand=True).astype(int)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def build(zip_bytes, out_root=GTFS_DIR, force=False):
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    feed_info = _read(z, "feed_info.txt").iloc[0]
    version = feed_info["feed_version"]
    out = Path(out_root) / version
    if (out / "feed.json").exists() and not force:
        print(f"feed {version} already loaded at {out}")
        return out
    out.mkdir(parents=True, exist_ok=True)
    (out / "source.zip").write_bytes(zip_bytes)

    routes = _read(z, "routes.txt")[["route_id", "route_short_name", "route_long_name", "route_type"]]
    routes["route_type"] = routes["route_type"].astype(int)

    stops = _read(z, "stops.txt")[["stop_id", "stop_name", "stop_lat", "stop_lon", "parent_station"]]
    stops["stop_lat"] = stops["stop_lat"].astype(float)
    stops["stop_lon"] = stops["stop_lon"].astype(float)
    stops["x"], stops["y"] = to_metric(stops["stop_lon"], stops["stop_lat"])

    print("shapes...")
    sh = _read(z, "shapes.txt")
    sh["seq"] = sh["shape_pt_sequence"].astype(int)
    sh = sh.sort_values(["shape_id", "seq"])
    sh["x"], sh["y"] = to_metric(sh["shape_pt_lon"].astype(float), sh["shape_pt_lat"].astype(float))
    shape_rows = []
    lines = {}
    for shape_id, g in sh.groupby("shape_id", sort=False):
        line = shapely.LineString(np.column_stack([g["x"].to_numpy(), g["y"].to_numpy()]))
        lines[shape_id] = line
        shape_rows.append((shape_id, shapely.to_wkb(line), line.length))
    shapes = pd.DataFrame(shape_rows, columns=["shape_id", "wkb", "length_m"])

    print("stop_times...")
    st = _read(z, "stop_times.txt", usecols=["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])
    st["stop_sequence"] = st["stop_sequence"].astype(int)
    st = st.sort_values(["trip_id", "stop_sequence"])
    st["idx"] = st.groupby("trip_id").cumcount().astype(np.int32)
    st["arr_s"] = _gtfs_seconds(st["arrival_time"]).astype(np.int32)
    st["dep_s"] = _gtfs_seconds(st["departure_time"]).astype(np.int32)
    stop_times = st[["trip_id", "idx", "stop_id", "arr_s", "dep_s"]].reset_index(drop=True)

    trips = _read(z, "trips.txt")[["trip_id", "route_id", "service_id", "direction_id", "shape_id", "trip_headsign"]]

    # A pattern is a shape plus an ordered stop list; trips sharing one share stop distances.
    print("patterns...")
    stop_lists = stop_times.groupby("trip_id", sort=False)["stop_id"].agg("|".join).rename("stop_list")
    trips = trips.merge(stop_lists, on="trip_id", how="left")
    keys = trips[["shape_id", "stop_list"]].drop_duplicates().reset_index(drop=True)
    keys["pattern_id"] = keys["shape_id"] + "#" + keys.groupby("shape_id").cumcount().astype(str)
    trips = trips.merge(keys, on=["shape_id", "stop_list"]).drop(columns="stop_list")

    stop_xy = stops.set_index("stop_id")[["x", "y"]]
    ps_rows = []
    for row in keys.itertuples():
        stop_ids = row.stop_list.split("|")
        xy = stop_xy.loc[stop_ids]
        dense = DenseShape(lines[row.shape_id])
        dists, offsets = locate_stops_on_shape(dense, xy["x"].to_numpy(), xy["y"].to_numpy())
        for i, (sid, d, off) in enumerate(zip(stop_ids, dists, offsets)):
            ps_rows.append((row.pattern_id, row.shape_id, i, sid, float(d), float(off)))
    pattern_stops = pd.DataFrame(ps_rows, columns=["pattern_id", "shape_id", "idx", "stop_id", "dist_m", "offset_m"])

    print("segments...")
    # Stop-to-stop segments, shared by every pattern that serves the same consecutive stops.
    ps = pattern_stops.sort_values(["pattern_id", "idx"])
    nxt = ps.groupby("pattern_id").shift(-1)
    seg = ps.assign(to_stop_id=nxt["stop_id"], to_dist_m=nxt["dist_m"], to_offset_m=nxt["offset_m"]).dropna(subset=["to_stop_id"])
    seg = seg.rename(columns={"stop_id": "from_stop_id", "dist_m": "from_dist_m"})
    seg["segment_id"] = seg["from_stop_id"] + ">" + seg["to_stop_id"]
    pattern_route = trips.drop_duplicates("pattern_id").set_index("pattern_id")["route_id"]
    seg["route_id"] = seg["pattern_id"].map(pattern_route)
    # How far the end stops are from the shape; large values mean bad stop coordinates.
    seg["stop_offset_m"] = np.maximum(seg["offset_m"], seg["to_offset_m"].astype(float))
    seg_routes = seg.groupby("segment_id")["route_id"].agg(lambda s: ",".join(sorted(set(s), key=lambda r: (len(r), r))))
    first = seg.drop_duplicates("segment_id").set_index("segment_id")
    seg_rows = []
    for sid, r in first.iterrows():
        piece = shapely.ops.substring(lines[r["shape_id"]], r["from_dist_m"], r["to_dist_m"])
        coords = shapely.get_coordinates(piece)
        if len(coords) < 2:
            coords = np.vstack([coords, coords])
        lon, lat = to_wgs84(coords[:, 0], coords[:, 1])
        seg_rows.append((sid, r["from_stop_id"], r["to_stop_id"], r["to_dist_m"] - r["from_dist_m"],
                         seg_routes[sid], r["stop_offset_m"], json.dumps(np.round(np.column_stack([lon, lat]), 6).tolist())))
    segments = pd.DataFrame(seg_rows, columns=["segment_id", "from_stop_id", "to_stop_id", "length_m", "route_ids", "stop_offset_m", "coords_wgs84"])
    pattern_stops = pattern_stops.merge(  # segment that starts at each pattern stop
        seg[["pattern_id", "idx", "segment_id"]], on=["pattern_id", "idx"], how="left")

    calendar_dates = _read(z, "calendar_dates.txt")

    for name, df in [("routes", routes), ("stops", stops), ("shapes", shapes), ("stop_times", stop_times),
                     ("trips", trips), ("pattern_stops", pattern_stops), ("segments", segments),
                     ("calendar_dates", calendar_dates)]:
        df.to_parquet(out / f"{name}.parquet", index=False)

    meta = {
        "feed_version": version,
        "feed_start_date": feed_info["feed_start_date"],
        "feed_end_date": feed_info["feed_end_date"],
        "sha256": hashlib.sha256(zip_bytes).hexdigest(),
        "loaded_at": datetime.now(timezone.utc).isoformat(),
        "counts": {"routes": len(routes), "trips": len(trips), "patterns": len(keys), "segments": len(segments)},
        "max_stop_offset_m": float(pattern_stops["offset_m"].max()),
    }
    (out / "feed.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))
    return out


def versions(root=GTFS_DIR):
    out = []
    for p in Path(root).glob("*/feed.json"):
        out.append(json.loads(p.read_text()))
    return sorted(out, key=lambda m: (m["feed_start_date"], m["feed_version"]))


def version_for(service_date: str, root=GTFS_DIR):
    """Newest loaded feed whose validity starts on or before service_date (YYYYMMDD)."""
    valid = [m for m in versions(root) if m["feed_start_date"] <= service_date <= m["feed_end_date"]]
    if not valid:
        raise SystemExit(f"no static GTFS loaded that covers {service_date}; run python -m analytics.static_gtfs")
    return Path(root) / valid[-1]["feed_version"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    if args.zip:
        data = Path(args.zip).read_bytes()
    else:
        print(f"downloading {args.url}")
        with urllib.request.urlopen(args.url) as r:
            data = r.read()
    build(data, force=args.force)


if __name__ == "__main__":
    sys.exit(main())
