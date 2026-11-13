"""Where the jobs read and write: local files under DATA_DIR, or an S3-compatible bucket (R2/B2).

Keys are the same either way (raw/..., gtfs/<feed_version>/..., derived/<date>/...).
The bucket is used when ARCHIVE_S3_BUCKET is set, with the same variables as the ingest worker.
"""

import io
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

from . import DATA_DIR

FETCH_THREADS = 16


class FileStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.description = f"filesystem ({self.root})"

    def list(self, prefix):
        base = self.root / prefix
        # A prefix may end mid-name (e.g. "gtfs/"), so walk from its directory and filter.
        start = base if prefix.endswith("/") else base.parent
        if not start.exists():
            return []
        keys = (p.relative_to(self.root).as_posix() for p in start.rglob("*") if p.is_file())
        return sorted(k for k in keys if k.startswith(prefix) and not Path(k).name.startswith("."))

    def get(self, key):
        return (self.root / key).read_bytes()

    def put(self, key, body: bytes):
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_bytes(body)
        tmp.replace(path)

    def exists(self, key):
        return (self.root / key).is_file()


class S3Store:
    def __init__(self, bucket, endpoint, region, access_key_id, secret_access_key):
        import boto3
        from botocore.config import Config

        # The R2 dashboard shows the S3 URL with the bucket appended; the bucket goes in requests, not the endpoint.
        endpoint = endpoint.rstrip("/")
        if endpoint.endswith(f"/{bucket}"):
            endpoint = endpoint[: -len(bucket) - 1]
        self.bucket = bucket
        self.description = f"s3 ({endpoint}, bucket {bucket})"
        self.client = boto3.client(
            "s3", endpoint_url=endpoint, region_name=region,
            aws_access_key_id=access_key_id, aws_secret_access_key=secret_access_key,
            config=Config(
                max_pool_connections=FETCH_THREADS * 2,
                retries={"max_attempts": 5, "mode": "standard"},
                # R2 and B2 don't support every checksum newer boto3 sends by default.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    def list(self, prefix):
        keys = []
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            keys.extend(o["Key"] for o in page.get("Contents", []))
        return sorted(keys)

    def get(self, key):
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def put(self, key, body: bytes):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body)

    def exists(self, key):
        from botocore.exceptions import ClientError

        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
                return False
            raise


def get_many(store, keys, chunk=256):
    """Yield (key, bytes) in order, fetching in parallel but holding at most `chunk` objects at a time."""
    with ThreadPoolExecutor(FETCH_THREADS) as pool:
        for i in range(0, len(keys), chunk):
            part = keys[i:i + chunk]
            yield from zip(part, pool.map(store.get, part))


def read_parquet(store, key, **kw):
    return pd.read_parquet(io.BytesIO(store.get(key)), **kw)


def parquet_bytes(df):
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    return buf.getvalue()


def from_env(env=os.environ):
    bucket = env.get("ARCHIVE_S3_BUCKET")
    if not bucket:
        return FileStore(DATA_DIR)
    missing = [k for k in ("ARCHIVE_S3_ENDPOINT", "ARCHIVE_S3_ACCESS_KEY_ID", "ARCHIVE_S3_SECRET_ACCESS_KEY") if not env.get(k)]
    if missing:
        raise SystemExit(f"ARCHIVE_S3_BUCKET is set but missing: {', '.join(missing)}")
    return S3Store(bucket, env["ARCHIVE_S3_ENDPOINT"], env.get("ARCHIVE_S3_REGION", "auto"),
                   env["ARCHIVE_S3_ACCESS_KEY_ID"], env["ARCHIVE_S3_SECRET_ACCESS_KEY"])
