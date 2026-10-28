import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { webcrypto } from 'crypto';
import { AwsClient } from 'aws4fetch';

// aws4fetch signs with WebCrypto; Node 18 doesn't always expose it globally.
if (!globalThis.crypto?.subtle) {
    globalThis.crypto = webcrypto;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

// raw/YYYY/MM/DD/HH/YYYYMMDDTHHMMSSZ.pb.gz, all in UTC (fetch time).
export function snapshotKey(date, prefix = 'raw') {
    const y = date.getUTCFullYear();
    const mo = pad(date.getUTCMonth() + 1);
    const d = pad(date.getUTCDate());
    const h = pad(date.getUTCHours());
    const mi = pad(date.getUTCMinutes());
    const s = pad(date.getUTCSeconds());
    return `${prefix}/${y}/${mo}/${d}/${h}/${y}${mo}${d}T${h}${mi}${s}Z.pb.gz`;
}

class FileArchive {
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.description = `filesystem (${rootDir})`;
    }

    async put(key, body) {
        const path = join(this.rootDir, key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body);
    }

    async get(key) {
        return readFile(join(this.rootDir, key));
    }

    async list(prefix) {
        const keys = [];
        const walk = async (dir) => {
            let entries;
            try {
                entries = await readdir(join(this.rootDir, dir), { withFileTypes: true });
            } catch (error) {
                if (error.code === 'ENOENT') return;
                throw error;
            }
            for (const entry of entries) {
                const key = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isDirectory()) await walk(key);
                else keys.push(key);
            }
        };
        await walk(prefix.replace(/\/$/, ''));
        return keys.sort();
    }
}

// Any S3-compatible store: Cloudflare R2, Backblaze B2, MinIO. Path-style URLs.
class S3Archive {
    constructor({ endpoint, bucket, region, accessKeyId, secretAccessKey }) {
        this.baseUrl = `${endpoint.replace(/\/$/, '')}/${bucket}`;
        this.client = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' });
        this.description = `s3 (${this.baseUrl})`;
    }

    async request(url, init) {
        const response = await this.client.fetch(url, init);
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`S3 ${init?.method || 'GET'} ${url} failed: ${response.status} ${text.slice(0, 300)}`);
        }
        return response;
    }

    async put(key, body) {
        await this.request(`${this.baseUrl}/${key}`, {
            method: 'PUT',
            body,
            headers: { 'Content-Type': 'application/octet-stream' },
        });
    }

    async get(key) {
        const response = await this.request(`${this.baseUrl}/${key}`);
        return Buffer.from(await response.arrayBuffer());
    }

    async list(prefix) {
        const keys = [];
        let token = null;
        do {
            const params = new URLSearchParams({ 'list-type': '2', prefix });
            if (token) params.set('continuation-token', token);
            const response = await this.request(`${this.baseUrl}?${params}`);
            const xml = await response.text();
            for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(key);
            token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null;
        } while (token);
        return keys.sort();
    }
}

export function createArchive(env = process.env) {
    if (env.ARCHIVE_S3_BUCKET) {
        const missing = ['ARCHIVE_S3_ENDPOINT', 'ARCHIVE_S3_ACCESS_KEY_ID', 'ARCHIVE_S3_SECRET_ACCESS_KEY']
            .filter((name) => !env[name]);
        if (missing.length) {
            throw new Error(`ARCHIVE_S3_BUCKET is set but missing: ${missing.join(', ')}`);
        }
        return new S3Archive({
            endpoint: env.ARCHIVE_S3_ENDPOINT,
            bucket: env.ARCHIVE_S3_BUCKET,
            region: env.ARCHIVE_S3_REGION || 'auto',
            accessKeyId: env.ARCHIVE_S3_ACCESS_KEY_ID,
            secretAccessKey: env.ARCHIVE_S3_SECRET_ACCESS_KEY,
        });
    }
    return new FileArchive(env.ARCHIVE_DIR || join(process.cwd(), 'data'));
}
