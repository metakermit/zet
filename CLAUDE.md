# CLAUDE.md

Real-time map of Zagreb public transport (ZET trams and buses), being extended into an analytics tool that finds where vehicles lose time in traffic. **Read `PLAN.md` before any non-trivial work.** It holds the architecture, metrics, processing method and phases.

## Current code

- `src/index.js`: `ZagrebGTFSClient`. Fetches the ZET GTFS-RT protobuf (`https://www.zet.hr/gtfs-rt-protobuf`), decodes it with protobufjs using `proto/gtfs-realtime.proto`, and flattens VehiclePositions to JSON. Non-vehicle entities are dropped.
- `server.js`: Express. `GET /api/vehicles` with a 10 s in-memory cache (stale data served on error), plus static files from `public/`.
- `public/app.js`: vanilla Leaflet map. Polls every 5 s, emoji markers with route labels, locate-me control. Tram vs bus is currently guessed from route number (< 100 = tram).
- `worker/ingest.js`: ingest worker. Archives every new raw snapshot (gzipped) via `src/archive.js` (filesystem by default, S3-compatible when `ARCHIVE_S3_*` is set). `scripts/inspect-archive.js` summarises a day. See README for env vars.
- `analytics/` (Python, `.venv`): `static_gtfs.py` loads versioned static GTFS (patterns, stop distances along shapes, stop-to-stop segments) into `data/gtfs/<feed_version>/`; `process_day.py` turns one service day of raw archive into `data/derived/<date>/` (traversals, stop crossings, 15-min bins, `segments.geojson`, `summary.json`). Proof of concept: files instead of PostGIS for now.
- `public/analytics.html` + `analytics.js`: dashboard at `/analytics`, served from `data/derived` by `server.js`.
- `render.yaml`: Render Blueprint (web service + ingest worker, Frankfurt).
- Node ≥ 20 (`.nvmrc` pins the major), ESM (`"type": "module"`). `npm run dev` runs nodemon with the inspector.

## Direction (see PLAN.md)

- Hosting moves from Vercel to **Render**: web service, background worker (ingest), cron job (nightly processing), Postgres + PostGIS. Raw archive goes in Cloudflare R2 / Backblaze B2.
- Don't rely on TimescaleDB community features (compression, continuous aggregates); Render doesn't offer them. Plain Postgres + PostGIS.
- The ingest worker archives **every raw protobuf snapshot**; that archive is the source of truth.
- Processing jobs are Python (shapely, pandas, pyproj) and idempotent per service day. Derived rows carry `method_version`.
- Geometry in EPSG:3765 (HTRS96/TM, metres).
- Static GTFS loads are versioned per feed.

## Conventions

- Keep the live map working at every step; analytics are additive.
- Prefer small, reviewable PRs that follow the phases in PLAN.md.
- Times: store UTC; display Europe/Zagreb. GTFS service times can exceed 24:00.
