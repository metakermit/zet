// Summarises the raw archive for one UTC day and decodes the latest snapshot.
// Usage: npm run archive:inspect [-- YYYY-MM-DD]

import { gunzipSync } from 'zlib';
import ZagrebGTFSClient from '../src/index.js';
import { createArchive } from '../src/archive.js';

const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const [y, m, d] = day.split('-');
const prefix = `${process.env.ARCHIVE_PREFIX || 'raw'}/${y}/${m}/${d}/`;

const archive = createArchive();
const keys = (await archive.list(prefix)).filter((key) => key.endsWith('.pb.gz'));

console.log(`archive: ${archive.description}`);
console.log(`prefix:  ${prefix}`);
console.log(`snapshots: ${keys.length}`);
if (!keys.length) process.exit(0);

const perHour = {};
for (const key of keys) {
    const hour = key.slice(prefix.length, prefix.length + 2);
    perHour[hour] = (perHour[hour] || 0) + 1;
}
console.log('per UTC hour:', perHour);
console.log(`first: ${keys[0]}`);
console.log(`last:  ${keys[keys.length - 1]}`);

const client = new ZagrebGTFSClient();
await client.initialize();
const latest = keys[keys.length - 1];
const bytes = gunzipSync(await archive.get(latest));
const feed = client.FeedMessage.decode(bytes);
const vehicles = feed.entity.filter((e) => e.vehicle);
const withTrip = vehicles.filter((e) => e.vehicle.trip?.tripId);
const headerTs = Number(feed.header.timestamp);

console.log(`\nlatest snapshot: ${bytes.length} bytes raw`);
console.log(`  header timestamp: ${new Date(headerTs * 1000).toISOString()}`);
console.log(`  entities: ${feed.entity.length} (vehicle: ${vehicles.length}, tripUpdate: ${feed.entity.filter((e) => e.tripUpdate).length}, alert: ${feed.entity.filter((e) => e.alert).length})`);
console.log(`  vehicles with tripId: ${withTrip.length}`);
