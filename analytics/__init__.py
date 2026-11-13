"""ZET analytics processing jobs. See PLAN.md for the method."""

import os
from pathlib import Path

# Bump whenever the processing method changes; derived rows carry it.
METHOD_VERSION = "poc-2"

DATA_DIR = Path(os.environ.get("ARCHIVE_DIR", Path(__file__).resolve().parent.parent / "data"))
RAW_PREFIX = os.environ.get("ARCHIVE_PREFIX", "raw")

LOCAL_TZ = "Europe/Zagreb"
METRIC_CRS = "EPSG:3765"  # HTRS96/TM, metres
