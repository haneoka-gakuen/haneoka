type RecordValue = Record<string, unknown>;
interface UploadOptions {
  signal: AbortSignal;
  progress: (loaded: number, total: number) => void;
  request: (url: string, init?: RequestInit) => Promise<RecordValue>;
  unavailable: string;
}
function uploadUrl(value: unknown): string {
  const url = new URL(String(value || ""), location.origin);
  if (url.origin !== location.origin || !/^\/api\/v1\/community\/uploads\/[0-9a-f-]{36}\//i.test(url.pathname))
    throw new Error("Invalid media upload URL");
  return url.href;
}
function putBlob(url: string, blob: Blob, mediaType: string, options: UploadOptions, offset: number, total: number) {
  return new Promise<RecordValue>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer = 0;
    let stalled = false;
    const abort = () => xhr.abort();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    };
    const deadline = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, 45000);
    };
    xhr.open("PUT", uploadUrl(url));
    xhr.setRequestHeader("Content-Type", mediaType);
    xhr.upload.onprogress = (event) => {
      deadline();
      options.progress(offset + Math.min(event.loaded, blob.size), total);
    };
    xhr.onload = () => {
      cleanup();
      let data: RecordValue = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(String((data.error as RecordValue | undefined)?.message || `HTTP ${xhr.status}`)));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error(options.unavailable));
    };
    xhr.onabort = () => {
      cleanup();
      reject(stalled ? new Error(options.unavailable) : new DOMException("Aborted", "AbortError"));
    };
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    options.signal.addEventListener("abort", abort, { once: true });
    deadline();
    xhr.send(blob);
  });
}

export async function uploadCommunityAttachment(
  attachment: RecordValue,
  file: Blob,
  options: UploadOptions,
): Promise<RecordValue> {
  options.signal.throwIfAborted();
  const multipart = attachment.multipart as RecordValue | undefined;
  if (!multipart) {
    const response = await putBlob(
      String(attachment.uploadUrl),
      file,
      String(attachment.mediaType || file.type),
      options,
      0,
      file.size,
    );
    return (response.attachment as RecordValue | undefined) || response;
  }
  const partSize = Number(multipart.partSize),
    partCount = Number(multipart.partCount);
  if (
    !Number.isInteger(partSize) ||
    partSize < 1024 * 1024 ||
    partSize > 16 * 1024 * 1024 ||
    partCount !== Math.ceil(file.size / partSize)
  )
    throw new Error("Invalid multipart upload configuration");
  const uploaded = new Map<number, { partNumber: number; etag: string }>();
  for (const entry of Array.isArray(multipart.parts) ? multipart.parts : []) {
    const row = entry as RecordValue;
    const partNumber = Number(row.partNumber),
      expected = Math.min(partSize, file.size - (partNumber - 1) * partSize);
    if (
      Number.isInteger(partNumber) &&
      partNumber >= 1 &&
      partNumber <= partCount &&
      typeof row.etag === "string" &&
      row.etag &&
      Number(row.byteSize) === expected
    )
      uploaded.set(partNumber, { partNumber, etag: row.etag });
  }
  let completed = [...uploaded.keys()].reduce(
    (total, index) => total + Math.min(partSize, file.size - (index - 1) * partSize),
    0,
  );
  options.progress(completed, file.size);
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    options.signal.throwIfAborted();
    if (uploaded.has(partNumber)) continue;
    const part = file.slice((partNumber - 1) * partSize, Math.min(partNumber * partSize, file.size));
    const path = String(multipart.partUploadUrl || "").replace("{partNumber}", String(partNumber));
    const response = await putBlob(path, part, "application/octet-stream", options, completed, file.size);
    const result = response.part as RecordValue | undefined;
    if (Number(result?.partNumber) !== partNumber || typeof result?.etag !== "string" || !result.etag)
      throw new Error("Invalid uploaded part response");
    uploaded.set(partNumber, { partNumber, etag: result.etag });
    completed += part.size;
    options.progress(completed, file.size);
  }
  const response = await options.request(uploadUrl(multipart.completeUrl), {
    method: "POST",
    signal: options.signal,
    body: JSON.stringify({ parts: [...uploaded.values()].sort((left, right) => left.partNumber - right.partNumber) }),
  });
  return (response.attachment as RecordValue | undefined) || response;
}

export async function retryCommunityAttachment(
  attachmentId: string,
  options: Pick<UploadOptions, "signal" | "request">,
): Promise<RecordValue> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId))
    throw new Error("Invalid media attachment ID");
  options.signal.throwIfAborted();
  const response = await options.request(`/api/v1/community/attachments/${attachmentId}/retry`, {
    method: "POST",
    signal: options.signal,
  });
  return (response.attachment as RecordValue | undefined) || response;
}
