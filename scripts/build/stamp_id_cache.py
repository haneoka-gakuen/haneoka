"""First-successful-derivative cache shared by Intl and Intl test builds."""
from __future__ import annotations

import time
import uuid
from botocore.exceptions import ClientError

INDEX = "private/textless-stamps/id-cache/v1/index.json"
LOCK = "private/textless-stamps/id-cache/v1/lock.json"
SCHEMA = "haneoka-stamp-id-cache-v1"
OBJECTS = "private/textless-stamps/id-cache/v1/objects"


class StampIdCache:
    def __init__(self, store):
        self.store = store
        self.owner = str(uuid.uuid4())
        self.records = {}
        self.etag = None
        self.lock_etag = None
        self.dirty = False

    def __enter__(self):
        deadline = time.monotonic() + 3600
        while True:
            head = self.store.head(LOCK)
            lock = self.store.get_json(LOCK) if head else None
            if not lock or lock.get("expiresAt", 0) <= time.time():
                try:
                    self.store.put_json(LOCK, {"owner": self.owner, "expiresAt": time.time() + 7200}, "no-store",
                                        expected_etag=head["ETag"] if head else None, if_absent=head is None)
                    self.lock_etag = self.store.head(LOCK)["ETag"]
                    break
                except ClientError as error:
                    if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") not in (409, 412):
                        raise
            if time.monotonic() >= deadline:
                raise TimeoutError("stamp ID cache is busy; retry this build")
            time.sleep(5)
        try:
            head = self.store.head(INDEX)
            self.etag = head["ETag"] if head else None
            document = self.store.get_json(INDEX) if head else None
            if document is not None:
                if document.get("schema") != SCHEMA or not isinstance(document.get("records"), dict):
                    raise ValueError("invalid shared stamp ID cache")
                self.records = document["records"]
        except BaseException:
            self.__exit__()
            raise
        return self

    def renew(self):
        self.store.put_json(LOCK, {"owner": self.owner, "expiresAt": time.time() + 7200}, "no-store",
                            expected_etag=self.lock_etag)
        self.lock_etag = self.store.head(LOCK)["ETag"]

    def remember(self, record):
        stamp_id = str(record["stampId"])
        if not stamp_id.isdecimal() or int(stamp_id) <= 0 or record.get("publishable") is not True:
            raise ValueError("invalid reusable stamp ID record")
        if stamp_id not in self.records:
            self.records[stamp_id] = record
            self.dirty = True

    def restore(self, record, target):
        from core.storage import cas_key
        asset = record["artifacts"]["sourceImage"]
        self.store.download_file(record.get("cacheImageKey") or cas_key(asset["sha256"]), target,
                                 expected_sha256=asset["sha256"])

    def preserve_image(self, record, file):
        stamp_id = str(record["stampId"])
        prior = self.records.get(stamp_id)
        if prior and prior.get("cacheImageKey"):
            return
        digest = record["artifacts"]["sourceImage"]["sha256"]
        key = f"{OBJECTS}/{digest}.png"
        self.store.upload_path(file, key, "image/png", cache_control="public, max-age=31536000, immutable")
        self.records[stamp_id] = {**(prior or record), "cacheImageKey": key}
        self.dirty = True

    def save(self):
        if not self.dirty:
            return
        self.renew()
        self.store.put_json(INDEX, {"schema": SCHEMA, "records": self.records}, "no-store",
                            expected_etag=self.etag, if_absent=self.etag is None)
        self.etag = self.store.head(INDEX)["ETag"]
        self.dirty = False

    def __exit__(self, *_):
        self.store.put_json(LOCK, {"owner": self.owner, "expiresAt": 0}, "no-store",
                            expected_etag=self.lock_etag)
