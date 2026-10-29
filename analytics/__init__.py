"""ZET analytics processing jobs. See PLAN.md for the method."""

import os
from pathlib import Path

# Bump whenever the processing method changes; derived rows carry it.
METHOD_VERSION = "poc-1"

DATA_DIR = Path(os.environ.get("ARCHIVE_DIR", Path(__file__).resolve().parent.parent / "data"))
RAW_PREFIX = os.environ.get("ARCHIVE_PREFIX", "raw")
GTFS_DIR = DATA_DIR / "gtfs"
DERIVED_DIR = DATA_DIR / "derived"

LOCAL_TZ = "Europe/Zagreb"
METRIC_CRS = "EPSG:3765"  # HTRS96/TM, metres
