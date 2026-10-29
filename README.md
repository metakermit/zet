# Zagreb Public Transport Live Map

A real-time map application that displays the current positions of public transport vehicles (trams and buses) in Zagreb, Croatia. The application uses the GTFS (General Transit Feed Specification) real-time feed provided by ZET (Zagreb Electric Tram).

## Features

- Real-time vehicle tracking with 10-second updates
- Different icons for trams (🚃) and buses (🚌)
- Route numbers displayed next to vehicles
- Detailed vehicle information in popups:
  - Vehicle type and line number
  - Vehicle ID and license plate
  - Current status and speed
  - Direction and occupancy information
  - Last update timestamp

## Technical Stack

- Node.js with Express for the backend server
- GTFS real-time protocol buffer for data parsing
- Leaflet.js for the interactive map
- OpenStreetMap for map tiles

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Development

- The server automatically restarts when files change (using nodemon)
- Vehicle positions are updated every 10 seconds
- The map is centered on Zagreb with a zoom level suitable for viewing the entire city

## Ingest worker (raw archive)

`worker/ingest.js` polls the GTFS-RT feed every 10 s and archives each new snapshot as gzipped protobuf under `raw/YYYY/MM/DD/HH/YYYYMMDDTHHMMSSZ.pb.gz` (UTC fetch time). Byte-identical consecutive snapshots are skipped. If the archive is unreachable, snapshots are buffered in memory (up to ~1 h) and flushed when it recovers. A stats line is logged every minute, including the observed feed refresh interval.

Run it locally (writes to `./data/` by default):

```bash
npm run ingest          # or: npm run ingest:dev (restarts on changes)
npm run archive:inspect # summary of today's (UTC) snapshots + decode of the latest
npm run archive:inspect -- 2026-10-28
```

Configuration (environment variables):

| Variable | Default | |
|---|---|---|
| `ARCHIVE_DIR` | `./data` | Filesystem archive root, used when no S3 bucket is set |
| `ARCHIVE_S3_BUCKET` | | Enables the S3-compatible archive (Cloudflare R2, Backblaze B2, MinIO) |
| `ARCHIVE_S3_ENDPOINT` | | e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.eu-central-003.backblazeb2.com` |
| `ARCHIVE_S3_REGION` | `auto` | `auto` for R2; the region in the endpoint for B2 |
| `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY` | | Credentials with write + list access to the bucket |
| `ARCHIVE_PREFIX` | `raw` | Key prefix |
| `INGEST_POLL_INTERVAL_MS` | `10000` | |
| `INGEST_STATS_INTERVAL_MS` | `60000` | |

**Node 18 and zet.hr's certificate:** zet.hr uses a Sectigo R46 root that Node 18's bundled CA list doesn't include, so fetches fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (this affects `npm run dev` too). Use a newer Node LTS, or point Node at the macOS roots:

```bash
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > ~/.macos-roots.pem
export NODE_EXTRA_CA_CERTS=~/.macos-roots.pem
```

## Analytics (proof of concept)

Python jobs in `analytics/` turn the raw archive into per-segment time-loss statistics, and `/analytics` shows them on a map. Outputs are files for now (Parquet + GeoJSON under `data/`); they move to Postgres + PostGIS once hosting is set up.

```bash
PYTHON=python3.13 npm run analytics:setup   # once: creates .venv (tested with Python 3.13)
npm run analytics:static                    # download + load ZET static GTFS into data/gtfs/<feed_version>/
npm run analytics:process -- 2026-10-28     # process one service day into data/derived/2026-10-28/
npm run dev                                 # then open http://localhost:3000/analytics
```

`analytics:process` accepts `--min-samples N` (default 20), the number of traversals a segment needs before it gets a free-flow baseline. With only an hour or two of data, use something like `--min-samples 3`. Reprocessing a day replaces its output.

What it does, per service day (see PLAN.md for the reasoning):

1. Reads pings from the archive, drops stale (> 5 min old), duplicate, trip-less, cancelled-trip and out-of-area pings.
2. Projects each ping onto its trip's shape in EPSG:3765, searching only near the previous position (50 m back, up to 30 m/s forward), so loops work. The first ping of a trip, and any ping after 3 consecutive off-route pings (> 40 m), is anchored to the pass of the shape closest to where the schedule puts the vehicle.
3. Interpolates when each stop is passed; consecutive stops give stop-to-stop segment traversals.
4. Splits each traversal into dwell (stopped within 30 m of a stop), stopped elsewhere and running time. "Stopped" means moving slower than 1 m/s between pings.
5. Free-flow running time is the 15th percentile over the trailing 28 days of processed days. **Time lost = stopped elsewhere + max(0, running − free flow).**
6. Punctuality (passing time vs scheduled departure), delay growth per segment, headway CV per route and hour, vehicles in service per minute, km driven.

## Data Source

The application uses the GTFS real-time feed from ZET:
- Feed URL: `https://www.zet.hr/gtfs-rt-protobuf`
- Protocol buffer definition: `proto/gtfs-realtime.proto`

## License

This project is open source and available under the MIT License. 