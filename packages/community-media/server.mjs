import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';

const PORT = boundedInteger(process.env.PORT, 8080, 1, 65535);
const TMP_ROOT = resolve(process.env.MEDIA_TMP_DIR || '/tmp/community-media');
const MAX_BYTES = boundedInteger(process.env.MEDIA_MAX_BYTES, 128 * 1024 * 1024, 1, 128 * 1024 * 1024);
const MAX_DURATION_SECONDS = boundedNumber(process.env.MEDIA_MAX_DURATION_SECONDS, 600, 1, 600);
const PROCESS_CONCURRENCY = boundedInteger(process.env.MEDIA_PROCESS_CONCURRENCY, 1, 1, 2);
const QUEUE_CAPACITY = boundedInteger(process.env.MEDIA_QUEUE_CAPACITY, 32, 1, 64);
const JOB_TIMEOUT_MS = boundedInteger(process.env.MEDIA_JOB_TIMEOUT_MS, 15 * 60 * 1000, 10_000, 30 * 60 * 1000);
const COMMAND_TIMEOUT_MS = boundedInteger(process.env.MEDIA_COMMAND_TIMEOUT_MS, 12 * 60 * 1000, 5_000, 20 * 60 * 1000);
const JOB_RETENTION_MS = boundedInteger(process.env.MEDIA_JOB_RETENTION_MS, 6 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const MAX_ERROR_BYTES = 16 * 1024;
const SERVICE_TOKEN = process.env.COMMUNITY_MEDIA_TOKEN || process.env.MEDIA_SERVICE_TOKEN || '';
const KNOWN_OUTPUTS = new Set(['media.webp', 'poster.webp', 'thumb.webp', 'media.mp4', 'moderation.jpg']);
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime', 'application/octet-stream',
]);

const jobs = new Map();
const queue = [];
let activeJobs = 0;
let shuttingDown = false;

await mkdir(TMP_ROOT, { recursive: true, mode: 0o700 });
await removeAbandonedDirectories();
const cleanupTimer = setInterval(() => { void cleanupExpiredJobs(); }, 60_000);
cleanupTimer.unref();

const server = http.createServer((request, response) => {
  void route(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendError(response, 500, 'INTERNAL_ERROR', 'The media service could not complete the request.');
    console.error('[media] request failure', error);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 10_000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[media] listening on 0.0.0.0:${PORT} concurrency=${PROCESS_CONCURRENCY} queue=${QUEUE_CAPACITY}`);
  if (!SERVICE_TOKEN) console.warn('[media] COMMUNITY_MEDIA_TOKEN/MEDIA_SERVICE_TOKEN is unset; private deployment must set it');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const job of jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') cancelJob(job, 'SERVICE_SHUTDOWN');
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}

async function route(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, SERVICE_TOKEN ? 401 : 503, 'UNAUTHORIZED', SERVICE_TOKEN ? 'A valid private service token is required.' : 'MEDIA_SERVICE_TOKEN is not configured.');
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (request.method === 'POST' && segments.length === 1 && segments[0] === 'jobs') {
    await createJob(request, response);
    return;
  }
  if (segments.length >= 2 && segments[0] === 'jobs') {
    const id = decodeJobId(segments[1]);
    if (!id) {
      sendError(response, 400, 'INVALID_JOB_ID', 'The job ID is invalid.');
      return;
    }
    if (segments.length === 2 && request.method === 'GET') {
      getJob(response, id);
      return;
    }
    if (segments.length === 3 && segments[2] === 'outputs' && request.method === 'GET') {
      listOutputs(response, id);
      return;
    }
    if (segments.length === 4 && segments[2] === 'outputs' && request.method === 'GET') {
      await streamOutput(response, id, segments[3]);
      return;
    }
    if (segments.length === 2 && request.method === 'DELETE') {
      await deleteJob(response, id);
      return;
    }
  }
  sendError(response, 404, 'NOT_FOUND', 'The requested media endpoint does not exist.');
}

function isAuthorized(request) {
  if (!SERVICE_TOKEN) return true;
  const presented = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : request.headers['x-community-media-token'];
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = Buffer.from(SERVICE_TOKEN);
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function createJob(request, response) {
  if (shuttingDown) {
    sendError(response, 503, 'SERVICE_SHUTDOWN', 'The media service is shutting down.', { 'retry-after': '15' });
    return;
  }
  const jobId = request.headers['x-community-media-job-id'] || request.headers['idempotency-key'];
  const id = typeof jobId === 'string' ? decodeJobId(jobId) : null;
  if (!id) {
    sendError(response, 400, 'JOB_ID_REQUIRED', 'Send the caller-owned attachment UUID in X-Community-Media-Job-Id.');
    return;
  }

  const existing = jobs.get(id);
  if (existing) {
    request.resume();
    sendJson(response, existing.state === 'succeeded' ? 200 : 202, publicJob(existing));
    return;
  }
  if (queue.length >= QUEUE_CAPACITY) {
    sendError(response, 503, 'QUEUE_FULL', 'The media processor queue is full; retry this job ID later.', { 'retry-after': '10' });
    return;
  }

  const contentLengthHeader = request.headers['content-length'];
  const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
  if (contentLength != null && (!Number.isFinite(contentLength) || contentLength < 0)) {
    sendError(response, 400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
    return;
  }
  if (contentLength != null && contentLength === 0) {
    sendError(response, 400, 'EMPTY_UPLOAD', 'The media upload is empty.');
    return;
  }
  if (contentLength != null && contentLength > MAX_BYTES) {
    sendError(response, 413, 'UPLOAD_TOO_LARGE', `The original media file exceeds ${MAX_BYTES} bytes.`);
    return;
  }
  const contentType = normalizeMime(request.headers['content-type']);
  if (contentType && !ALLOWED_MIME.has(contentType)) {
    sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image and video media uploads are accepted.');
    return;
  }

  const workDir = await mkdtemp(join(TMP_ROOT, `${id}-`));
  const inputPath = join(workDir, 'original.bin');
  try {
    const bytes = await writeUpload(request, inputPath);
    const source = await inspectSource(inputPath, contentType, bytes);
    if (source.durationSeconds != null && source.durationSeconds > MAX_DURATION_SECONDS + 0.05) {
      throw mediaError('DURATION_LIMIT', `Video duration ${source.durationSeconds.toFixed(2)}s exceeds the ${MAX_DURATION_SECONDS}s limit.`);
    }
    const job = {
      id,
      state: 'queued',
      progress: 0,
      source,
      workDir,
      inputPath,
      outputMap: new Map(),
      outputs: [],
      error: null,
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      controller: null,
    };
    jobs.set(id, job);
    queue.push(job);
    sendJson(response, 202, publicJob(job));
    pumpQueue();
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    const status = error.code === 'UPLOAD_TOO_LARGE' ? 413 : error.code === 'UNSUPPORTED_MEDIA' ? 415 : error.code === 'DURATION_LIMIT' ? 422 : 422;
    sendError(response, status, error.code || 'INVALID_MEDIA', error.publicMessage || 'The upload is not a supported media file.');
  }
}

async function writeUpload(request, inputPath) {
  let total = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        callback(mediaError('UPLOAD_TOO_LARGE', `The original media file exceeds ${MAX_BYTES} bytes.`));
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(request, limiter, createWriteStream(inputPath, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (total > MAX_BYTES) error.code = 'UPLOAD_TOO_LARGE';
    throw error;
  }
  if (total === 0) throw mediaError('EMPTY_UPLOAD', 'The media upload is empty.');
  return total;
}

async function inspectSource(inputPath, hintedMime, bytes) {
  const header = await readHeader(inputPath);
  const detected = detectMagic(header);
  if (!detected) throw mediaError('UNSUPPORTED_MEDIA', 'The upload is not a supported JPEG, PNG, WebP, GIF, HEIC, MP4, WebM, or MOV file.');
  if (hintedMime && hintedMime !== 'application/octet-stream' && !mimeMatchesKind(hintedMime, detected.kind)) {
    throw mediaError('UNSUPPORTED_MEDIA', 'The declared media type does not match the file contents.');
  }

  if (detected.kind === 'video') {
    const probe = await ffprobe(inputPath);
    const stream = probe.streams.find((entry) => entry.codec_type === 'video');
    if (!stream) throw mediaError('UNSUPPORTED_MEDIA', 'The video has no decodable video stream.');
    const duration = parseFinite(stream.duration ?? probe.format?.duration);
    if (duration == null || duration <= 0) throw mediaError('UNSUPPORTED_MEDIA', 'The video duration could not be determined.');
    return {
      mediaType: detected.mediaType,
      kind: 'video',
      bytes,
      durationSeconds: duration,
      width: parseInteger(stream.width),
      height: parseInteger(stream.height),
      fps: parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate),
      hasAudio: probe.streams.some((entry) => entry.codec_type === 'audio'),
    };
  }

  const image = await identifyImage(inputPath);
  return {
    mediaType: detected.mediaType,
    kind: 'image',
    bytes,
    durationSeconds: detected.kind === 'gif' ? image.frames > 1 ? image.durationSeconds : null : null,
    width: image.width,
    height: image.height,
    animated: detected.kind === 'gif' && image.frames > 1,
    alpha: image.alpha,
  };
}

function detectMagic(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { kind: 'image', mediaType: 'image/jpeg' };
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mediaType: 'image/png' };
  if (header.length >= 6 && (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a')) return { kind: 'gif', mediaType: 'image/gif' };
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return { kind: 'image', mediaType: 'image/webp' };
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = [];
    for (let offset = 8; offset + 4 <= Math.min(header.length, 64); offset += 4) brands.push(header.subarray(offset, offset + 4).toString('ascii'));
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))) return { kind: 'heic', mediaType: 'image/heic' };
    if (brands.includes('qt  ')) return { kind: 'video', mediaType: 'video/quicktime' };
    return { kind: 'video', mediaType: 'video/mp4' };
  }
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'video', mediaType: 'video/webm' };
  return null;
}

function mimeMatchesKind(mime, kind) {
  if (kind === 'video') return mime.startsWith('video/');
  if (kind === 'heic') return mime === 'image/heic' || mime === 'image/heif';
  if (kind === 'gif') return mime === 'image/gif';
  return mime.startsWith('image/');
}

async function identifyImage(inputPath) {
  const output = await runCommand('identify', [
    '-quiet', '-limit', 'memory', '768MiB', '-limit', 'map', '768MiB', '-limit', 'disk', '1GiB',
    '-format', '%w|%h|%n|%[opaque]|%T\\n', inputPath,
  ], { timeoutMs: 90_000 });
  const lines = output.stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) throw mediaError('UNSUPPORTED_MEDIA', 'The image dimensions could not be read.');
  const [width, height, frames, opaque, delay] = lines[0].split('|');
  const frameCount = Math.max(1, parseInteger(frames) || lines.length);
  const durationSeconds = frameCount > 1 ? lines.reduce((sum, line) => sum + (parseFinite(line.split('|')[4]) || 0), 0) / 100 : null;
  return {
    width: parseInteger(width),
    height: parseInteger(height),
    frames: frameCount,
    alpha: String(opaque).toLowerCase() !== 'true',
    durationSeconds: durationSeconds || (frameCount > 1 ? (parseFinite(delay) || 0) / 100 : null),
  };
}

async function ffprobe(inputPath) {
  const result = await runCommand('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file', '-protocol_blacklist', 'http,https,tcp,tls,ftp,rtmp,rtmps,udp,data,pipe',
    '-show_streams', '-show_format', '-of', 'json', inputPath,
  ], { timeoutMs: 90_000 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw mediaError('UNSUPPORTED_MEDIA', 'The media metadata could not be read.');
  }
}

function pumpQueue() {
  while (activeJobs < PROCESS_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.state !== 'queued') continue;
    activeJobs += 1;
    void processJob(job).finally(() => {
      activeJobs -= 1;
      pumpQueue();
    });
  }
}

async function processJob(job) {
  job.state = 'running';
  job.progress = 0.05;
  job.updatedAt = new Date().toISOString();
  const controller = new AbortController();
  job.controller = controller;
  const deadline = setTimeout(() => controller.abort(mediaError('JOB_TIMEOUT', 'Media conversion exceeded the service time limit.')), JOB_TIMEOUT_MS);
  try {
    if (job.source.kind === 'video') await processVideo(job, controller.signal);
    else if (job.source.animated) await processGif(job, controller.signal);
    else await processStill(job, controller.signal);
    await hydrateOutputMetadata(job);
    await unlink(job.inputPath).catch(() => {});
    job.state = 'succeeded';
    job.progress = 1;
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    await unlink(job.inputPath).catch(() => {});
    if (job.state !== 'cancelled') {
      job.state = controller.signal.aborted ? 'failed' : 'failed';
      job.error = { code: error.code || 'CONVERSION_FAILED', message: error.publicMessage || 'Media conversion failed.' };
      job.progress = 1;
      job.updatedAt = new Date().toISOString();
      console.error(`[media] job ${job.id} failed`, error.publicMessage || error.message || error);
    }
  } finally {
    clearTimeout(deadline);
    job.controller = null;
  }
}

async function processStill(job, signal) {
  job.progress = 0.2;
  const sourcePath = await materializeImage(job);
  const mediaPath = join(job.workDir, 'media.webp');
  const thumbPath = join(job.workDir, 'thumb.webp');
  await convertImage(sourcePath, mediaPath, 2560, 82, signal);
  job.progress = 0.72;
  await convertImage(sourcePath, thumbPath, 480, 78, signal);
  const moderationPath = join(job.workDir, 'moderation.jpg');
  await convertJpeg(sourcePath, moderationPath, 1024, signal);
  job.progress = 0.92;
  registerOutput(job, 'media.webp', mediaPath, 'webmedia', 'image/webp', job.source.width, job.source.height);
  registerOutput(job, 'poster.webp', mediaPath, 'poster', 'image/webp', job.source.width, job.source.height);
  registerOutput(job, 'thumb.webp', thumbPath, 'thumbnail', 'image/webp');
  registerOutput(job, 'moderation.jpg', moderationPath, 'moderation', 'image/jpeg');
}

async function processGif(job, signal) {
  const posterPath = join(job.workDir, 'poster.webp');
  const thumbPath = join(job.workDir, 'thumb.webp');
  const mediaPath = join(job.workDir, 'media.mp4');
  const moderationPath = join(job.workDir, 'moderation.jpg');
  await convertImage(job.inputPath + '[0]', posterPath, 2560, 82, signal);
  job.progress = 0.25;
  await convertImage(job.inputPath + '[0]', thumbPath, 480, 78, signal);
  job.progress = 0.45;
  await createContactSheet(job.inputPath, moderationPath, job.source.durationSeconds || 1, signal);
  await encodeVideo(job, mediaPath, signal, { gif: true });
  job.progress = 0.92;
  registerOutput(job, 'poster.webp', posterPath, 'poster', 'image/webp');
  registerOutput(job, 'thumb.webp', thumbPath, 'thumbnail', 'image/webp');
  registerOutput(job, 'media.mp4', mediaPath, 'webmedia', 'video/mp4');
  registerOutput(job, 'moderation.jpg', moderationPath, 'moderation', 'image/jpeg');
}

async function processVideo(job, signal) {
  const posterPath = join(job.workDir, 'poster.webp');
  const thumbPath = join(job.workDir, 'thumb.webp');
  const mediaPath = join(job.workDir, 'media.mp4');
  const moderationPath = join(job.workDir, 'moderation.jpg');
  await extractVideoPoster(job.inputPath, posterPath, 2560, signal);
  job.progress = 0.25;
  await convertImage(posterPath, thumbPath, 480, 78, signal);
  job.progress = 0.4;
  await createContactSheet(job.inputPath, moderationPath, job.source.durationSeconds || 1, signal);
  await encodeVideo(job, mediaPath, signal, { gif: false });
  job.progress = 0.92;
  registerOutput(job, 'poster.webp', posterPath, 'poster', 'image/webp');
  registerOutput(job, 'thumb.webp', thumbPath, 'thumbnail', 'image/webp');
  registerOutput(job, 'media.mp4', mediaPath, 'webmedia', 'video/mp4');
  registerOutput(job, 'moderation.jpg', moderationPath, 'moderation', 'image/jpeg');
}

async function materializeImage(job) {
  if (job.source.mediaType !== 'image/heic' && job.source.mediaType !== 'image/heif') return job.inputPath;
  const pngPath = join(job.workDir, 'decoded.png');
  await runCommand('heif-convert', ['--quiet', job.inputPath, pngPath], { timeoutMs: COMMAND_TIMEOUT_MS, signal: job.controller.signal });
  return pngPath;
}

async function convertImage(inputPath, outputPath, maxSide, quality, signal) {
  await runCommand('convert', [
    '-quiet', '-limit', 'memory', '768MiB', '-limit', 'map', '768MiB', '-limit', 'disk', '1GiB',
    inputPath, '-auto-orient', '-strip', '-resize', `${maxSide}x${maxSide}>`, '-define', 'webp:method=4', '-quality', String(quality), outputPath,
  ], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
}

async function convertJpeg(inputPath, outputPath, maxSide, signal) {
  await runCommand('convert', [
    '-quiet', '-limit', 'memory', '768MiB', '-limit', 'map', '768MiB', '-limit', 'disk', '1GiB',
    inputPath, '-auto-orient', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-strip', '-resize', `${maxSide}x${maxSide}>`, '-quality', '78', outputPath,
  ], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
}

async function createContactSheet(inputPath, outputPath, durationSeconds, signal) {
  const safeDuration = Math.max(0.2, Math.min(MAX_DURATION_SECONDS, durationSeconds));
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-protocol_blacklist', 'http,https,tcp,tls,ftp,rtmp,rtmps,udp,data,pipe',
    '-i', inputPath, '-vf', `fps=9/${safeDuration},scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=black,tile=3x3`, '-frames:v', '1', '-q:v', '6', outputPath,
  ], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
}

async function extractVideoPoster(inputPath, outputPath, maxSide, signal) {
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-protocol_blacklist', 'http,https,tcp,tls,ftp,rtmp,rtmps,udp,data,pipe',
    '-ss', '0', '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libwebp', '-quality', '78', outputPath,
  ], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
}

async function encodeVideo(job, outputPath, signal, { gif }) {
  const duration = Math.max(job.source.durationSeconds || 1, 0.2);
  const sourceBytes = job.source.bytes;
  const audioBitrate = gif || !job.source.hasAudio ? 0 : 96_000;
  const targetBits = Math.max(32_000, sourceBytes * 8 * 0.86);
  const initialVideoBitrate = Math.max(120_000, Math.min(6_000_000, targetBits / duration - audioBitrate));
  const attempts = [initialVideoBitrate, initialVideoBitrate * 0.65, initialVideoBitrate * 0.42];
  for (let index = 0; index < attempts.length; index += 1) {
    const candidate = `${outputPath}.attempt-${index}.mp4`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-protocol_blacklist', 'http,https,tcp,tls,ftp,rtmp,rtmps,udp,data,pipe',
      '-i', job.inputPath, '-map', '0:v:0', ...(gif || !job.source.hasAudio ? [] : ['-map', '0:a:0?']), '-sn', '-dn',
      '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${Math.round(attempts[index])}`, '-maxrate', `${Math.round(attempts[index] * 1.15)}`, '-bufsize', `${Math.round(attempts[index] * 2)}`,
      '-fps_mode', 'vfr',
      ...(audioBitrate ? ['-c:a', 'aac', '-b:a', `${audioBitrate}`, '-ac', '2', '-ar', '48000'] : ['-an']),
      '-movflags', '+faststart', '-f', 'mp4', candidate,
    ];
    if (job.source.fps && job.source.fps > 30) {
      const fpsIndex = args.indexOf('-fps_mode');
      args.splice(fpsIndex, 0, '-r', '30');
    }
    await runCommand('ffmpeg', args, { timeoutMs: COMMAND_TIMEOUT_MS, signal });
    const candidateStat = await stat(candidate);
    if (candidateStat.size <= sourceBytes || index === attempts.length - 1) {
      if (candidateStat.size > sourceBytes) {
        job.warnings.push('The converted video exceeded the source byte target after quality fallback; it remains within the upload size limit.');
      }
      await rename(candidate, outputPath);
      return;
    }
    await unlink(candidate).catch(() => {});
  }
}

function registerOutput(job, name, filePath, kind, mediaType, width = null, height = null) {
  job.outputMap.set(name, filePath);
  job.outputs.push({ name, kind, mediaType, bytes: null, width, height, durationSeconds: null, fps: null });
}

async function streamOutput(response, id, outputName) {
  const job = jobs.get(id);
  if (!job) {
    sendError(response, 404, 'JOB_NOT_FOUND', 'The media job does not exist.');
    return;
  }
  if (job.state !== 'succeeded') {
    sendError(response, 409, 'OUTPUT_NOT_READY', 'The requested output is not ready.');
    return;
  }
  if (!KNOWN_OUTPUTS.has(outputName) || !job.outputMap.has(outputName)) {
    sendError(response, 404, 'OUTPUT_NOT_FOUND', 'The requested output name is not available for this job.');
    return;
  }
  const filePath = job.outputMap.get(outputName);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    sendError(response, 404, 'OUTPUT_NOT_FOUND', 'The generated output is no longer available.');
    return;
  }
  const mediaType = outputName.endsWith('.mp4') ? 'video/mp4' : outputName.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
  response.writeHead(200, {
    'content-type': mediaType,
    'content-length': String(fileStat.size),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(filePath).pipe(response);
}

function listOutputs(response, id) {
  const job = jobs.get(id);
  if (!job) {
    sendError(response, 404, 'JOB_NOT_FOUND', 'The media job does not exist.');
    return;
  }
  sendJson(response, job.state === 'succeeded' ? 200 : 202, { jobId: id, state: job.state, outputs: job.outputs });
}

function getJob(response, id) {
  const job = jobs.get(id);
  if (!job) {
    sendError(response, 404, 'JOB_NOT_FOUND', 'The media job does not exist.');
    return;
  }
  sendJson(response, job.state === 'succeeded' ? 200 : 202, publicJob(job));
}

async function deleteJob(response, id) {
  const job = jobs.get(id);
  if (!job) {
    sendError(response, 404, 'JOB_NOT_FOUND', 'The media job does not exist.');
    return;
  }
  cancelJob(job, 'CANCELLED_BY_CALLER');
  await rm(job.workDir, { recursive: true, force: true });
  jobs.delete(id);
  response.writeHead(204).end();
}

function cancelJob(job, code) {
  if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return;
  const position = queue.indexOf(job);
  if (position >= 0) queue.splice(position, 1);
  job.state = 'cancelled';
  job.error = { code, message: code === 'SERVICE_SHUTDOWN' ? 'The service is shutting down.' : 'The media job was cancelled.' };
  job.progress = 1;
  job.updatedAt = new Date().toISOString();
  job.controller?.abort(mediaError(code, job.error.message));
}

function publicJob(job) {
  return {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    source: job.source,
    outputs: job.outputs,
    error: job.error,
    warnings: job.warnings,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    statusUrl: `/jobs/${encodeURIComponent(job.id)}`,
    outputsUrl: `/jobs/${encodeURIComponent(job.id)}/outputs`,
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function sendError(response, status, code, message, extra = {}) {
  sendJson(response, status, { error: { code, message }, ...extra });
}

function normalizeMime(value) {
  if (typeof value !== 'string') return '';
  return value.split(';', 1)[0].trim().toLowerCase();
}

function decodeJobId(value) {
  if (typeof value !== 'string') return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded) ? decoded : null;
}

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFinite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFrameRate(value) {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function mediaError(code, publicMessage) {
  const error = new Error(publicMessage);
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
}

async function runCommand(command, args, { timeoutMs, signal } = {}) {
  if (signal?.aborted) throw signal.reason || mediaError('CANCELLED', 'The media job was cancelled.');
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const append = (target, chunk) => `${target}${chunk.toString('utf8')}`.slice(-MAX_ERROR_BYTES);
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const terminate = (reason) => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
      settle(reason);
    };
    const onAbort = () => terminate(signal.reason || mediaError('CANCELLED', 'The media job was cancelled.'));
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => settle(mediaError('COMMAND_UNAVAILABLE', `The media converter could not start (${command}).`), null));
    child.once('exit', (code, signalName) => {
      if (code === 0) settle(null, { stdout, stderr });
      else {
        const detail = stderr.replace(/\s+/g, ' ').trim().slice(-500);
        const error = mediaError(signalName ? 'COMMAND_TERMINATED' : 'CONVERSION_FAILED', detail ? `The media converter failed: ${detail}` : 'The media converter failed.');
        settle(error);
      }
    });
    timer = setTimeout(() => terminate(mediaError('COMMAND_TIMEOUT', 'The media converter exceeded its time limit.')), timeoutMs || COMMAND_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function removeAbandonedDirectories() {
  const entries = await readdir(TMP_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => rm(join(TMP_ROOT, entry.name), { recursive: true, force: true })));
}

async function cleanupExpiredJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (!['succeeded', 'failed', 'cancelled'].includes(job.state)) continue;
    if (Date.parse(job.updatedAt) > cutoff) continue;
    await rm(job.workDir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
  }
}

async function hydrateOutputMetadata(job) {
  for (const output of job.outputs) {
    const filePath = job.outputMap.get(output.name);
    const fileStat = await stat(filePath);
    output.bytes = fileStat.size;
    if (!output.mediaType.startsWith('video/')) {
      const image = await identifyImage(filePath);
      output.width = image.width;
      output.height = image.height;
      if (!Number.isSafeInteger(output.width) || output.width <= 0 || !Number.isSafeInteger(output.height) || output.height <= 0)
        throw mediaError('INVALID_OUTPUT', 'The converted media dimensions are invalid.');
    }
    output.sha256 = await hashFile(filePath);
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function readHeader(inputPath) {
  const handle = await open(inputPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
