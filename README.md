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

## Data Source

The application uses the GTFS real-time feed from ZET:
- Feed URL: `https://www.zet.hr/gtfs-rt-protobuf`
- Protocol buffer definition: `proto/gtfs-realtime.proto`

## License

This project is open source and available under the MIT License. 