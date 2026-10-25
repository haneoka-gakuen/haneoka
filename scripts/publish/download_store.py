# L3 — GEB
# Input: 下载存储配置、对象键与文件。
# Output: R2 对象读取与流式上传。
# Pos: [Map](L2-2.md)；安装包和离线清单发布的存储适配。
# Effects/Dependencies: 通过 S3 或显式选用的本机 Wrangler 身份访问 R2，不输出凭据。
from __future__ import annotations

import json
import io
import hashlib
import os
import time
import ssl
import subprocess
import threading
import tomllib
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

IMMUTABLE = "public, max-age=31536000, immutable"


class DownloadStore:
    _refresh_lock = threading.Lock()

    def __init__(self, bucket: str, *, wrangler: bool = False, cloudflare_token: bool = False):
        self.bucket = bucket
        self.wrangler = wrangler
        self.account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "0095917ca8180fcd95ed1f3f11ecf881")
        if wrangler:
            import urllib3
            config = Path.home() / ".config/.wrangler/config/default.toml"
            self.token_file = config
            self.token = tomllib.loads(config.read_text())["oauth_token"]
            proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
            options = {"maxsize": 4, "timeout": urllib3.Timeout(connect=15, read=60)}
            self.http = urllib3.ProxyManager(proxy, **options) if proxy else urllib3.PoolManager(**options)
            self.network_error = urllib3.exceptions.HTTPError
        else:
            import boto3
            from botocore.config import Config
            credentials = {}
            if cloudflare_token:
                token = os.environ["CLOUDFLARE_API_TOKEN"]
                identity = None
                for path in ("user/tokens/verify", f"accounts/{self.account}/tokens/verify"):
                    try:
                        request = Request("https://api.cloudflare.com/client/v4/" + path,
                                          headers={"Authorization": "Bearer " + token})
                        with urlopen(request, timeout=30) as response:
                            identity = json.load(response)["result"]
                        break
                    except HTTPError as error:
                        if error.code not in {401, 403, 404}:
                            raise
                if not identity or identity.get("status") != "active":
                    raise ValueError("Cloudflare deployment token could not be verified")
                credentials = {"aws_access_key_id": identity["id"],
                               "aws_secret_access_key": hashlib.sha256(token.encode()).hexdigest()}
            self.client = boto3.client("s3", endpoint_url=f"https://{self.account}.r2.cloudflarestorage.com",
                                       region_name="auto", config=Config(retries={"max_attempts": 8, "mode": "standard"}),
                                       **credentials)

    def _refresh(self, rejected):
        with self._refresh_lock:
            token = tomllib.loads(self.token_file.read_text())["oauth_token"]
            if token == rejected:
                subprocess.run(["pnpm", "exec", "wrangler", "whoami"], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                token = tomllib.loads(self.token_file.read_text())["oauth_token"]
            self.token = token

    def _request(self, key, *, method="GET", data=None, headers=None, query=None):
        url = f"https://api.cloudflare.com/client/v4/accounts/{self.account}/r2/buckets/{self.bucket}/objects"
        url += "/" + quote(key, safe="/") if key is not None else "?" + urlencode(query or {})
        for attempt in range(5):
            try:
                token = tomllib.loads(self.token_file.read_text())["oauth_token"]
                if hasattr(data, "seek"):
                    data.seek(0)
                response = self.http.request(method, url, body=data,
                    headers={"Authorization": "Bearer " + token, **(headers or {})},
                    preload_content=False, retries=False,
                    timeout=300 if method == "PUT" else 45)
                if response.status >= 400:
                    body = response.read()
                    if response.status == 401 and attempt < 4:
                        self._refresh(token)
                        continue
                    raise HTTPError(url, response.status, response.reason, response.headers, io.BytesIO(body))
                return response
            except HTTPError as error:
                if error.code not in {408, 429, 500, 502, 503, 504} or attempt == 4:
                    raise
            except (URLError, TimeoutError, ssl.SSLError, self.network_error):
                if attempt == 4:
                    raise
            time.sleep(min(8, 2 ** attempt))

    def get_bytes(self, key: str) -> bytes | None:
        if self.wrangler:
            for attempt in range(5):
                try:
                    with self._request(key) as response:
                        return response.read()
                except HTTPError as error:
                    if error.code == 404:
                        return None
                    raise
                except (URLError, TimeoutError, ssl.SSLError, self.network_error):
                    if attempt == 4:
                        raise
                    time.sleep(min(8, 2 ** attempt))
        from botocore.exceptions import ClientError
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] == 404:
                return None
            raise

    def get_json(self, key: str):
        body = self.get_bytes(key)
        return json.loads(body) if body is not None else None

    def put_file(self, key: str, file: Path, content_type: str, cache_control: str = IMMUTABLE):
        if self.wrangler:
            with file.open("rb") as stream:
                with self._request(key, method="PUT", data=stream,
                                   headers={"Content-Type": content_type, "Content-Length": str(file.stat().st_size),
                                            "Cache-Control": cache_control}) as response:
                    response.read()
        else:
            from boto3.s3.transfer import TransferConfig
            self.client.upload_file(str(file), self.bucket, key,
                                    ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
                                    Config=TransferConfig(max_concurrency=2, multipart_chunksize=32 << 20))

    def inventory(self, prefix: str):
        if self.wrangler:
            result, cursor = {}, None
            while True:
                query = {"prefix": prefix, "per_page": "1000", **({"cursor": cursor} if cursor else {})}
                with self._request(None, query=query) as response:
                    value = json.loads(response.read())
                result.update({row["key"]: {"etag": row["etag"].strip('"'), "size": row["size"]} for row in value["result"]})
                info = value.get("result_info", {})
                cursor = info.get("cursor") if info.get("is_truncated") else None
                if not cursor:
                    return result
        result = {}
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            result.update({row["Key"]: {"etag": row["ETag"].strip('"'), "size": row["Size"]} for row in page.get("Contents", [])})
        return result

    def matches(self, key: str, digest: str, size: int, *, file=None, inventory=None) -> bool:
        if inventory is not None:
            entry = inventory.get(key)
            if entry is None or entry["size"] != size:
                return False
            etag = entry["etag"]
            if file is not None and len(etag) == 32:
                with file.open("rb") as stream:
                    return hashlib.file_digest(stream, "md5").hexdigest() == etag
        try:
            stream = self._request(key) if self.wrangler else self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
        except HTTPError as error:
            if error.code == 404:
                return False
            raise
        except Exception as error:
            if not self.wrangler and getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return False
            raise
        value, length = hashlib.sha256(), 0
        with stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                value.update(chunk)
                length += len(chunk)
                if length > size:
                    return False
        return length == size and value.hexdigest() == digest

    def put_bytes(self, key: str, body: bytes, content_type="application/json", cache_control=IMMUTABLE):
        if self.wrangler:
            with self._request(key, method="PUT", data=body,
                               headers={"Content-Type": content_type, "Cache-Control": cache_control}) as response:
                response.read()
        else:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type, CacheControl=cache_control)


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
