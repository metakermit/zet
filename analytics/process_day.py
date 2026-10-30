"""Process one service day: project pings, cut traversals, split time, aggregate.

    python -m analytics.process_day YYYY-MM-DD [--min-samples N]

Idempotent: rewrites data/derived/<date>/ completely. Implements PLAN.md
steps 1-7 for stop-to-stop segments.
"""

import argparse
import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import DERIVED_DIR, LOCAL_TZ, METHOD_VERSION
from .geo import dense_shape, to_metric
from .pings import read_pings
from .static_gtfs import version_for

MAX_SPEED_MS = 30.0       # farthest plausible move between pings
BACK_TOLERANCE_M = 50.0   # search this far behind the last position
JITTER_M = 10.0           # backwards moves smaller than this are GPS noise
OFF_ROUTE_M = 40.0        # farther than this from the shape: detour / bad ping
REANCHOR_AFTER = 3        # consecutive off-route pings before searching the whole shape
STOPPED_SPEED_MS = 1.0    # slower than this between pings counts as stopped
DWELL_RADIUS_M = 30.0     # stopped within this distance of a stop is dwell
MAX_GAP_S = 60.0          # traversals with a longer ping gap are excluded from fine stats
FREE_FLOW_QUANTILE = 0.15
FREE_FLOW_WINDOW_DAYS = 28


def service_day_origin(service_date):
    """Epoch seconds of 'noon minus 12 h' local time, the zero point of GTFS times (DST-safe)."""
    tz = ZoneInfo(LOCAL_TZ)
    noon = datetime.strptime(service_date, "%Y%m%d").replace(hour=12, tzinfo=tz)
    return noon.timestamp() - 12 * 3600


class Static:
    def __init__(self, path: Path):
        self.path = path
        read = lambda name: pd.read_parquet(path / f"{name}.parquet")
        self.routes = read("routes").set_index("route_id")
        self.trips = read("trips").set_index("trip_id")
        self.stops = read("stops").set_index("stop_id")
        self.shapes = read("shapes").set_index("shape_id")
        self.segments = read("segments").set_index("segment_id")
        ps = read("pattern_stops").sort_values(["pattern_id", "idx"])
        self.pattern_stops = {pid: g.reset_index(drop=True) for pid, g in ps.groupby("pattern_id")}
        self.stop_times = read("stop_times")

    def dense(self, shape_id):
        return dense_shape(shape_id, self.shapes.at[shape_id, "wkb"])


def project_trip(t, x, y, dense, sched_t, sched_d, stats):
    """Distance along the shape for each ping, plus a run id; NaN for discarded pings.

    A run is a stretch of monotonic progress. Re-anchoring after a detour starts a new run.
    """
    n = len(t)
    d_out = np.full(n, np.nan)
    run_out = np.full(n, -1)
    last_d = last_t = None
    misses = 0
    run = -1
    for i in range(n):
        if last_d is None or misses >= REANCHOR_AFTER:
            cands = dense.candidates(x[i], y[i], OFF_ROUTE_M)
            if not cands:
                stats["off_route"] += 1
                misses += 1
                continue
            # Pick the pass of the shape closest to where the schedule says the vehicle is.
            expected = np.interp(t[i], sched_t, sched_d)
            d = min(cands, key=lambda c: abs(c[0] - expected))[0]
            run += 1
            stats["anchors"] += 1
        else:
            reach = MAX_SPEED_MS * (t[i] - last_t) + 100.0
            d, off = dense.nearest_in_window(x[i], y[i], last_d - BACK_TOLERANCE_M, last_d + reach)
            if off > OFF_ROUTE_M:
                stats["off_route"] += 1
                misses += 1
                continue
            if d < last_d - JITTER_M:
                stats["backwards"] += 1
                continue
            d = max(d, last_d)
        misses = 0
        last_d, last_t = d, t[i]
        d_out[i] = d
        run_out[i] = run
    return d_out, run_out


def crossings(t, d, boundaries):
    """Interpolated time at which a monotonic (t, d) track passes each boundary; NaN if not observed."""
    k = np.searchsorted(d, boundaries, side="left")
    ok = (k > 0) & (k < len(d))
    k_ok = np.where(ok, k, 1)
    d0, d1 = d[k_ok - 1], d[k_ok]
    t0, t1 = t[k_ok - 1], t[k_ok]
    with np.errstate(invalid="ignore", divide="ignore"):
        tc = t0 + (boundaries - d0) / (d1 - d0) * (t1 - t0)
    return np.where(ok, tc, np.nan), np.where(ok, t1 - t0, np.nan)


def split_time(t, d, stop_d):
    """Cumulative dwell / stopped-elsewhere / running seconds at each ping.

    Each ping interval is one category; interpolating these cumulative series at
    any two instants gives the split for the time in between.
    """
    dt = np.diff(t)
    dd = np.diff(d)
    stopped = dd < STOPPED_SPEED_MS * dt
    mid = (d[:-1] + d[1:]) / 2
    near = np.abs(mid[:, None] - stop_d[None, :]).min(axis=1) <= DWELL_RADIUS_M
    cats = {
        "dwell": stopped & near,
        "stopped": stopped & ~near,
        "running": ~stopped,
    }
    return {name: np.concatenate([[0.0], np.cumsum(np.where(mask, dt, 0.0))]) for name, mask in cats.items()}


def process_trips(pings, static, service_date):
    origin = service_day_origin(service_date)
    stats = {"trip_instances": 0, "no_static_trip": 0, "off_route": 0, "backwards": 0, "anchors": 0}
    trav_rows, cross_rows, km_rows = [], [], []
    st_by_trip = static.stop_times.set_index("trip_id").sort_index()

    pings = pings.copy()
    pings["x"], pings["y"] = to_metric(pings["lon"].to_numpy(), pings["lat"].to_numpy())

    for (trip_id, vehicle_id), g in pings.groupby(["trip_id", "vehicle_id"], sort=False):
        if trip_id not in static.trips.index:
            stats["no_static_trip"] += 1
            continue
        stats["trip_instances"] += 1
        trip = static.trips.loc[trip_id]
        ps = static.pattern_stops[trip["pattern_id"]]
        sched = st_by_trip.loc[[trip_id]].sort_values("idx")
        stop_d = ps["dist_m"].to_numpy()
        sched_t = origin + sched["dep_s"].to_numpy().astype(float)
        dense = static.dense(trip["shape_id"])

        t = g["ts"].to_numpy().astype(float)
        d, runs = project_trip(t, g["x"].to_numpy(), g["y"].to_numpy(), dense, sched_t, stop_d, stats)

        for run in np.unique(runs[runs >= 0]):
            m = runs == run
            tr, dr = t[m], d[m]
            if len(tr) < 2:
                continue
            km_rows.append((trip["route_id"], vehicle_id, trip_id, dr[-1] - dr[0], tr[-1] - tr[0]))
            tc, gap = crossings(tr, dr, stop_d)
            cum = split_time(tr, dr, stop_d)
            cum_at = {k: np.interp(tc, tr, v) for k, v in cum.items()}
            dt = np.diff(tr)

            for i in np.flatnonzero(~np.isnan(tc)):
                cross_rows.append((trip_id, vehicle_id, trip["route_id"], trip["direction_id"], int(i),
                                   ps.at[i, "stop_id"], tc[i], sched_t[i], gap[i]))
            for i in range(len(stop_d) - 1):
                entry, exit_ = tc[i], tc[i + 1]
                if np.isnan(entry) or np.isnan(exit_):
                    continue
                a = max(0, np.searchsorted(tr, entry, side="right") - 1)
                b = np.searchsorted(tr, exit_, side="left")
                max_gap = float(dt[a:b].max()) if b > a else float(gap[i + 1])
                trav_rows.append((
                    ps.at[i, "segment_id"], trip_id, vehicle_id, trip["route_id"], i,
                    entry, exit_, exit_ - entry,
                    cum_at["dwell"][i + 1] - cum_at["dwell"][i],
                    cum_at["stopped"][i + 1] - cum_at["stopped"][i],
                    cum_at["running"][i + 1] - cum_at["running"][i],
                    max_gap,
                    sched_t[i + 1] - sched_t[i],
                    (exit_ - sched_t[i + 1]) - (entry - sched_t[i]),
                ))

    trav = pd.DataFrame(trav_rows, columns=[
        "segment_id", "trip_id", "vehicle_id", "route_id", "stop_idx", "entry_ts", "exit_ts", "duration_s",
        "dwell_s", "stopped_s", "running_s", "max_gap_s", "scheduled_s", "delay_growth_s"])
    cross = pd.DataFrame(cross_rows, columns=[
        "trip_id", "vehicle_id", "route_id", "direction_id", "stop_idx", "stop_id", "cross_ts", "scheduled_ts", "gap_s"])
    cross["delay_s"] = cross["cross_ts"] - cross["scheduled_ts"]
    km = pd.DataFrame(km_rows, columns=["route_id", "vehicle_id", "trip_id", "metres", "seconds"])
    return trav, cross, km, stats


def free_flow(today_trav, service_date, min_samples):
    """15th percentile of running time per segment over the trailing window (including today)."""
    day = datetime.strptime(service_date, "%Y%m%d")
    frames = [today_trav]
    for k in range(1, FREE_FLOW_WINDOW_DAYS):
        p = DERIVED_DIR / (day - timedelta(days=k)).strftime("%Y-%m-%d") / "traversals.parquet"
        if p.exists():
            frames.append(pd.read_parquet(p, columns=["segment_id", "running_s", "max_gap_s", "method_version"]))
    all_trav = pd.concat(frames, ignore_index=True)
    good = all_trav[(all_trav["max_gap_s"] <= MAX_GAP_S) & (all_trav["method_version"] == METHOD_VERSION)]
    g = good.groupby("segment_id")["running_s"]
    ff = pd.DataFrame({"free_flow_s": g.quantile(FREE_FLOW_QUANTILE), "ff_samples": g.size()})
    return ff[ff["ff_samples"] >= min_samples], len(frames)


def headway_cv(cross, routes):
    """Coefficient of variation of gaps between consecutive vehicles, per route and local hour."""
    c = cross.sort_values("cross_ts")
    c["gap"] = c.groupby(["route_id", "direction_id", "stop_id"])["cross_ts"].diff()
    c = c[c["gap"].between(30, 3600)]
    c["hour"] = pd.to_datetime(c["cross_ts"], unit="s", utc=True).dt.tz_convert(LOCAL_TZ).dt.hour
    g = c.groupby(["route_id", "hour"])["gap"]
    out = pd.DataFrame({"gaps": g.size(), "mean_headway_s": g.mean(), "cv": g.std() / g.mean()}).reset_index()
    return out[out["gaps"] >= 10]


def write_outputs(out_dir, service_date, static, pings, coverage, trav, cross, km, stats, ff, ff_days, min_samples):
    tz = LOCAL_TZ
    trav = trav.join(ff, on="segment_id")
    trav["good"] = trav["max_gap_s"] <= MAX_GAP_S
    trav["excess_running_s"] = (trav["running_s"] - trav["free_flow_s"]).clip(lower=0)
    # Time lost to traffic: waiting away from stops plus running slower than free flow.
    trav["lost_s"] = trav["stopped_s"] + trav["excess_running_s"].fillna(0)
    entry_local = pd.to_datetime(trav["entry_ts"], unit="s", utc=True).dt.tz_convert(tz)
    trav["bin15"] = entry_local.dt.hour * 4 + entry_local.dt.minute // 15
    trav["hour"] = entry_local.dt.hour
    trav["method_version"] = METHOD_VERSION
    trav.to_parquet(out_dir / "traversals.parquet", index=False)

    cross["method_version"] = METHOD_VERSION
    cross.to_parquet(out_dir / "stop_crossings.parquet", index=False)

    good = trav[trav["good"]]
    agg_cols = dict(n=("duration_s", "size"), duration_s=("duration_s", "sum"), dwell_s=("dwell_s", "sum"),
                    stopped_s=("stopped_s", "sum"), running_s=("running_s", "sum"), lost_s=("lost_s", "sum"),
                    excess_running_s=("excess_running_s", "sum"), delay_growth_s=("delay_growth_s", "sum"),
                    median_duration_s=("duration_s", "median"))
    day_type = {5: "saturday", 6: "sunday"}.get(datetime.strptime(service_date, "%Y%m%d").weekday(), "weekday")
    bins = good.groupby(["segment_id", "bin15"]).agg(**agg_cols).reset_index()
    bins["day_type"] = day_type
    bins["method_version"] = METHOD_VERSION
    bins.to_parquet(out_dir / "segment_bins.parquet", index=False)

    # Vehicles in service per local minute (by snapshot time, so minutes before the archive started don't show partial counts).
    minute = pd.to_datetime(pings["poll_ts"], unit="s", utc=True).dt.tz_convert(tz).dt.floor("min")
    # t = minutes since local midnight of the service date; past-midnight service continues at 24:00+, like GTFS.
    midnight = pd.Timestamp(datetime.strptime(service_date, "%Y%m%d"), tz=tz)
    t = ((minute - midnight).dt.total_seconds() // 60).astype(int)
    vpm = pings.assign(t=t).groupby("t")["vehicle_id"].nunique()
    vpm_out = [{"t": int(m), "minute": f"{m // 60 % 24:02d}:{m % 60:02d}", "vehicles": int(v)} for m, v in vpm.items()]

    # Per-route summary.
    routes = static.routes
    hw = headway_cv(cross, routes)
    route_rows = []
    for route_id, g in trav.groupby("route_id"):
        c = cross[cross["route_id"] == route_id]
        h = hw[hw["route_id"] == route_id]
        route_rows.append({
            "route_id": route_id,
            "name": routes.at[route_id, "route_short_name"],
            "long_name": routes.at[route_id, "route_long_name"],
            "type": "tram" if routes.at[route_id, "route_type"] == 0 else "bus",
            "trips": int(g["trip_id"].nunique()),
            "km": round(float(km.loc[km["route_id"] == route_id, "metres"].sum()) / 1000, 1),
            "lost_h": round(float(g.loc[g["good"], "lost_s"].sum()) / 3600, 2),
            "dwell_h": round(float(g.loc[g["good"], "dwell_s"].sum()) / 3600, 2),
            "median_delay_s": None if c.empty else round(float(c["delay_s"].median())),
            "p90_delay_s": None if c.empty else round(float(c["delay_s"].quantile(0.9))),
            "headway_cv": None if h.empty else round(float((h["cv"] * h["gaps"]).sum() / h["gaps"].sum()), 2),
        })

    # Segment GeoJSON with per-hour sums so the dashboard can filter by time of day.
    hourly = good.groupby(["segment_id", "hour"]).agg(**{k: v for k, v in agg_cols.items() if k != "median_duration_s"})
    features = []
    stops = static.stops
    for seg_id, h in hourly.groupby(level=0):
        seg = static.segments.loc[seg_id]
        by_hour = {int(hr): [int(r.n), round(r.duration_s), round(r.dwell_s), round(r.stopped_s), round(r.running_s),
                             round(r.lost_s), round(r.delay_growth_s)]
                   for (_, hr), r in h.iterrows()}
        route_names = sorted({routes.at[r, "route_short_name"] for r in seg["route_ids"].split(",") if r in routes.index},
                             key=lambda s: (len(s), s))
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": json.loads(seg["coords_wgs84"])},
            "properties": {
                "id": seg_id,
                "from": stops.at[seg["from_stop_id"], "stop_name"],
                "to": stops.at[seg["to_stop_id"], "stop_name"],
                "length_m": round(float(seg["length_m"])),
                "routes": route_names,
                "tram": any(routes.at[r, "route_type"] == 0 for r in seg["route_ids"].split(",") if r in routes.index),
                "free_flow_s": None if seg_id not in ff.index else round(float(ff.at[seg_id, "free_flow_s"]), 1),
                "suspect_stops": bool(seg["stop_offset_m"] > 60),
                "h": by_hour,
            },
        })
    (out_dir / "segments.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))

    sched_total = trav["scheduled_s"].sum()
    summary = {
        "service_date": service_date,
        "method_version": METHOD_VERSION,
        "static_feed_version": static.path.name,
        "processed_at": datetime.now(ZoneInfo("UTC")).isoformat(),
        "coverage": {**coverage, **stats},
        "traversals": len(trav),
        "traversals_good": int(trav["good"].sum()),
        "segments_observed": int(trav["segment_id"].nunique()),
        "free_flow": {"segments": len(ff), "min_samples": min_samples, "window_days_found": ff_days},
        "km_driven": round(float(km["metres"].sum()) / 1000, 1),
        "vehicle_hours": {k: round(float(good[k].sum()) / 3600, 2)
                          for k in ["duration_s", "dwell_s", "stopped_s", "running_s", "excess_running_s", "lost_s"]},
        # Sanity check: observed vs scheduled time over the same segments (should be near 1).
        "observed_vs_scheduled": None if not sched_total else round(float(trav["duration_s"].sum() / sched_total), 3),
        "vehicles_per_minute": vpm_out,
        "routes": sorted(route_rows, key=lambda r: -r["lost_h"]),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1, default=float))
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("date", help="service date, YYYY-MM-DD")
    ap.add_argument("--min-samples", type=int, default=20, help="minimum traversals for a free-flow baseline")
    args = ap.parse_args()
    service_date = args.date.replace("-", "")

    static = Static(version_for(service_date))
    print(f"static feed {static.path.name}")
    pings, coverage = read_pings(service_date)
    print(f"{coverage['snapshots']} snapshots, {len(pings)} usable pings")
    if pings.empty:
        raise SystemExit("no pings for that service day")

    trav, cross, km, stats = process_trips(pings, static, service_date)
    trav["method_version"] = METHOD_VERSION
    ff, ff_days = free_flow(trav, service_date, args.min_samples)

    final = DERIVED_DIR / args.date
    tmp = DERIVED_DIR / f".{args.date}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    summary = write_outputs(tmp, service_date, static, pings, coverage, trav, cross, km, stats, ff, ff_days, args.min_samples)
    shutil.rmtree(final, ignore_errors=True)
    tmp.rename(final)

    brief = {k: v for k, v in summary.items() if k not in ("vehicles_per_minute", "routes")}
    print(json.dumps(brief, indent=1))
    print("top routes by lost hours:", [(r["name"], r["lost_h"]) for r in summary["routes"][:8]])


if __name__ == "__main__":
    main()
