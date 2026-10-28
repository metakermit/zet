// Ingest worker: polls the ZET GTFS-RT feed and archives every raw protobuf
// snapshot (gzipped) to the archive. The archive is the source of truth for
// all later processing, so this process should stay simple and always on.

import { createHash } from 'crypto';
import { promisify } from 'util';
import { gzip as gzipCb } from 'zlib';
import ZagrebGTFSClient from '../src/index.js';
import { createArchive, snapshotKey } from '../src/archive.js';

const gzip = promisify(gzipCb);

const FEED_URL = process.env.GTFS_REALTIME_URL || 'https://www.zet.hr/gtfs-rt-protobuf';
const POLL_INTERVAL_MS = parseInt(process.env.INGEST_POLL_INTERVAL_MS || '10000', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.INGEST_FETCH_TIMEOUT_MS || '8000', 10);
const STATS_INTERVAL_MS = parseInt(process.env.INGEST_STATS_INTERVAL_MS || '60000', 10);
const ARCHIVE_PREFIX = process.env.ARCHIVE_PREFIX || 'raw';
// Snapshots kept in memory while the archive is unreachable (~1 h at 10 s).
const MAX_PENDING = parseInt(process.env.INGEST_MAX_PENDING || '360', 10);

const archive = createArchive();
const client = new ZagrebGTFSClient();

const pending = [];
let lastHash = null;
let lastFeedTimestamp = null;
let stopping = false;
let timer = null;
let inFlight = null;

// Reset after every stats log line.
let stats = newStats();
function newStats() {
    return { polls: 0, archived: 0, unchanged: 0, fetchErrors: 0, writeErrors: 0, dropped: 0, feedIntervals: [] };
}

function log(message, extra) {
    const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
    console.log(`${new Date().toISOString()} ${line}`);
}

async function fetchFeed() {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function flushPending() {
    while (pending.length) {
        const { key, body } = pending[0];
        try {
            await archive.put(key, body);
        } catch (error) {
            stats.writeErrors++;
            log(`archive write failed, ${pending.length} pending: ${error.message}`);
            return;
        }
        pending.shift();
        stats.archived++;
    }
}

async function poll() {
    const fetchedAt = new Date();
    stats.polls++;

    let bytes;
    let feed;
    try {
        bytes = await fetchFeed();
        // Decode only to make sure we're archiving a real feed and not an error page.
        feed = client.FeedMessage.decode(bytes);
    } catch (error) {
        stats.fetchErrors++;
        log(`fetch failed: ${error.message}${error.cause ? ` (${error.cause.code || error.cause.message})` : ''}`);
        return;
    }

    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash === lastHash) {
        stats.unchanged++;
    } else {
        lastHash = hash;
        const feedTimestamp = Number(feed.header?.timestamp || 0);
        if (lastFeedTimestamp && feedTimestamp > lastFeedTimestamp) {
            stats.feedIntervals.push(feedTimestamp - lastFeedTimestamp);
        }
        lastFeedTimestamp = feedTimestamp;

        pending.push({ key: snapshotKey(fetchedAt, ARCHIVE_PREFIX), body: await gzip(bytes) });
        if (pending.length > MAX_PENDING) {
            pending.shift();
            stats.dropped++;
        }
    }

    await flushPending();
}

function logStats() {
    const intervals = [...stats.feedIntervals].sort((a, b) => a - b);
    const feedAgeS = lastFeedTimestamp ? Math.round(Date.now() / 1000 - lastFeedTimestamp) : null;
    log('stats', {
        ...stats,
        feedIntervals: undefined,
        pending: pending.length,
        feedAgeS,
        // How often ZET actually refreshes the feed (open question in PLAN.md).
        feedIntervalMedianS: intervals.length ? intervals[Math.floor(intervals.length / 2)] : null,
    });
    stats = newStats();
}

async function loop() {
    const start = Date.now();
    let tick = 0;
    const run = async () => {
        if (stopping) return;
        inFlight = poll();
        await inFlight;
        tick++;
        // Schedule against the start time so slow polls don't make the cadence drift.
        const delay = Math.max(0, start + tick * POLL_INTERVAL_MS - Date.now());
        if (!stopping) timer = setTimeout(run, delay);
    };
    await run();
}

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    await inFlight;
    log(`${signal} received, flushing ${pending.length} pending snapshot(s)`);
    await flushPending();
    logStats();
    process.exit(pending.length ? 1 : 0);
}

async function main() {
    await client.initialize();
    log('ingest worker starting', {
        feed: FEED_URL,
        archive: archive.description,
        prefix: ARCHIVE_PREFIX,
        pollIntervalMs: POLL_INTERVAL_MS,
    });
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    setInterval(logStats, STATS_INTERVAL_MS).unref();
    await loop();
}

main().catch((error) => {
    console.error('ingest worker crashed:', error);
    process.exit(1);
});
