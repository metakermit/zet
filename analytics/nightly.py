"""Nightly job: load ZET's current static GTFS, then process the service day that just ended.

    python -m analytics.nightly [--date YYYY-MM-DD] [--min-samples N]

Runs as a Render cron job against the R2 bucket (ARCHIVE_S3_* variables), or
locally against data/. Schedule it after 06:00 Europe/Zagreb: a service day's
pings run until 06:00 the next morning.
"""

import argparse
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import LOCAL_TZ
from . import store as stores
from .process_day import print_summary, process_day
from .static_gtfs import build, download


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="service date, YYYY-MM-DD (default: yesterday in Zagreb)")
    ap.add_argument("--min-samples", type=int, default=20, help="minimum traversals for a free-flow baseline")
    args = ap.parse_args()
    date = args.date or f"{datetime.now(ZoneInfo(LOCAL_TZ)).date() - timedelta(days=1):%Y-%m-%d}"
    started = time.monotonic()

    store = stores.from_env()
    print(f"store: {store.description}; service day {date}", flush=True)

    # Loading every night keeps one version per published feed, so each day is
    # matched against the schedule that was valid then. A failed download isn't
    # fatal: the day can still use a feed loaded earlier.
    try:
        build(download(), store)
    except Exception as e:  # noqa: BLE001
        print(f"warning: static GTFS update failed, using loaded versions: {e!r}", file=sys.stderr, flush=True)

    print_summary(process_day(store, date, args.min_samples))
    print(f"done in {time.monotonic() - started:.0f} s", flush=True)


if __name__ == "__main__":
    main()
