# ZET analytics — plan

Extend the live map into an analytical tool. It continuously records where ZET trams and buses are and measures **where and when they lose time**, so we can argue which parts of the city need traffic reorganised (for example physically separating trams or buses from cars).

## Goal and core metric

Raw speed and punctuality don't justify a bus lane by themselves. A slow segment can come from passengers boarding, traffic lights or congestion. So every segment traversal is split into causes:

- **Dwell**: time stopped within ~30 m of a stop (boarding, which lanes won't fix).
- **Stopped elsewhere**: time stopped away from stops (lights or traffic, the clearest sign of interference).
- **Running time**: what's left.

**Excess delay** = running time − free-flow time for that segment, clipped at 0. Free-flow time is the 15th percentile of running time over a rolling 4 weeks, with a minimum sample size. Summed over trips, this gives **vehicle-hours lost per segment per hour of the week**, the main ranking metric.

To argue for separation we also need a counterfactual. Each segment is tagged with whether the vehicle is physically separated or runs in mixed traffic (from OSM, checked by hand where unclear), plus its traffic-signal count (OSM `highway=traffic_signals`). Then "mixed-traffic segments lose X min/day versus comparable separated ones" is a direct argument.

Other tracked metrics:

- Vehicles in service per minute
- km driven
- Punctuality against the static schedule
- **Delay growth per segment** (delay at exit stop − delay at entry stop): pins lateness on the segment where it builds up
- **Headway regularity** (coefficient of variation of gaps between vehicles) for frequent tram lines, where riders don't use the timetable

## Architecture

```
ZET GTFS-RT feed ──► ingest worker ──► raw .pb archive (R2/B2)
                         │                    │
                         ▼                    ▼
Static GTFS + OSM ──► segment loader ──► nightly processing jobs ──► Postgres + PostGIS ──► dashboard
```

### Hosting: Render (move off Vercel)

Vercel can't run an always-on process. Background options there are time-limited functions (default 300 s), and Hobby cron runs only once a day. Render runs everything in one place:

| Component | Render service | Notes |
|---|---|---|
| Live map + dashboard + API | Web service | The existing Express app. Remove the `NODE_ENV !== 'production'` guard around `listen()` and delete `vercel.json`. |
| Ingest worker | Background worker | Long-running; polls the feed |
| Nightly processing | Cron job | Billed per minute while it runs |
| Database | Render Postgres | PostGIS enabled |
| Raw archive | — | Render has no object storage; use Cloudflare R2 or Backblaze B2 |

Expected cost is about $20–25/month at the smallest tiers. Pick an EU region (Frankfurt) if available.

**TimescaleDB:** Render offers it without the community-licensed features, which as far as we know includes compression and continuous aggregates. **We don't depend on Timescale.** Raw pings live in the archive, and aggregates are computed by our own nightly jobs, so plain Postgres + PostGIS is enough.

Side benefit: the web service can serve the worker's latest snapshot, so ZET is polled from a single place instead of per request.

### Ingest worker

- One loop, no task queue. Poll the GTFS-RT feed every ~10 s; the actual ZET refresh rate still needs measuring.
- Write every raw protobuf snapshot to object storage (e.g. `raw/YYYY/MM/DD/HH/<ts>.pb`). **This is the source of truth.** The method will change, and only raw data lets us recompute history. Volume is a few GB per month compressed.
- Optionally also insert decoded positions into Postgres for fast access to recent data.
- **Start this first.** Every day without it is data we can't get back.

### Static GTFS + segment loader

- Load ZET's static GTFS (`routes`, `trips`, `stops`, `stop_times`, `shapes`) **versioned per feed**, so realtime `tripId`s are matched against the schedule that was valid at the time.
- Store shapes in HTRS96/TM (**EPSG:3765**) so distances are in metres.
- Two segment models:
  - **stop-to-stop**: aligns with the schedule, used for punctuality
  - **fixed 100–200 m pieces of street**: localises problems; a tram line and a bus line on the same street share them
- Tag segments with separation status and signal count from OSM.
- `routes.txt` `route_type` replaces the current "route number < 100 means tram" guess in the live map.

### Nightly processing jobs (per service day, ~04:00 the next morning)

Write these in Python (shapely, pandas, pyproj). The per-vehicle walk is stateful and too slow as PostGIS round-trips per ping. Keep PostGIS for loading shapes and for dashboard queries.

1. **Clean.** Deduplicate on `(vehicle_id, vehicle.timestamp)`, not poll time. Drop pings with no `tripId`, but count them as a coverage metric. Drop depot and out-of-city pings.
2. **Project onto the trip's shape.** Use linear referencing (equivalent to `ST_LineLocatePoint(shape, pt) * ST_Length(shape)`); no HMM map-matching needed for v1.
   - Loops and turnarounds: only search near the last known position, from ~50 m behind to the farthest plausible distance since. Discard pings that move backwards along the route.
   - Detours: offset > ~40 m from the shape → flag the trip, don't force the match.
3. **Interpolate boundary crossings.** For consecutive pings (d₁,t₁) and (d₂,t₂), boundary *b* is crossed at t₁ + (b−d₁)/(d₂−d₁)·(t₂−t₁). Traversal time = exit − entry. Store the ping gap as a quality flag and exclude traversals with gaps > ~60 s from fine-grained statistics.
4. **Split each traversal** into dwell, stopped elsewhere and running time (see above).
5. **Compute** free-flow baseline and excess delay.
6. **Punctuality.** Stops projected onto shapes give stop crossing times; compare with `stop_times`. GTFS times can exceed 24:00 and are measured relative to noon − 12 h, so DST days need care. Compute delay growth per segment and headway regularity.
7. **Aggregate.** Segment × 15-min bin × day type; vehicles in service per minute; km driven.

**Engineering rules**

- Jobs are idempotent per service day: delete and re-insert.
- Every derived row carries `method_version`, so changing the method means re-running instead of migrating.
- Validate before trusting: segment times summed along a trip ≈ trip duration; known slow spots from experience should stand out.

### Dashboard

Built into the existing app: MapLibre / deck.gl with segments coloured by vehicle-hours lost, a time-of-day slider, and per-segment drill-down (travel-time distribution, dwell vs stopped vs running, punctuality). Also a ranked **top 20 segments by lost hours** list, which is the most persuasive single view.

## Phases

1. **Move to Render and start archiving.** Web service plus ingest worker writing raw `.pb` to R2/B2. Urgent: data starts accumulating from here.
2. **Static GTFS + segment model.** Versioned loads, both segment types, OSM separation and signal tags.
3. **Processing jobs.** Prototype steps 1–3 against a day or two of archive first; projection on looping routes is the riskiest part. Then dwell split, baselines, punctuality, aggregates.
4. **Dashboard.**

## Open questions

- Actual refresh rate of the ZET GTFS-RT feed, and whether it carries TripUpdates as well as VehiclePositions
- How often ZET publishes new static GTFS, and whether realtime `tripId`s match it reliably
- Whether `occupancyStatus` is ever populated (it would allow passenger weighting instead of trip counts)

## Known issues in the current live map (fix along the way)

- Express error handler is registered before routes, so it never fires.
- The init middleware runs on every request and is redundant.
- Leaflet CSS 1.7.1 vs JS 1.9.4.
- `setIcon()` runs on every marker every poll, and `vehicles.find` inside a loop is O(n²).
- No staleness check on `vehicle.timestamp` (ghost vehicles).
- Dead code: unused location globals, `node-fetch`, and the `main()` guard in `src/index.js`.
- `package-lock.json` is gitignored, so builds aren't reproducible.
- README says 10 s updates; the client polls every 5 s.
