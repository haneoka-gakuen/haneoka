FROM node:24-bookworm-slim

# ffmpeg provides video/GIF decoding and H.264/AAC encoding. ImageMagick and
# libheif are used for bounded still-image conversion, including HEIC.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ffmpeg \
    imagemagick \
    libheif-examples \
    util-linux \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY packages/community-media/package.json packages/community-media/server.mjs packages/community-media/recognition.mjs ./
COPY packages/community-media/recognition ./recognition
COPY scripts/recognize ./recognize
RUN python3 -m venv /opt/recognition \
  && /opt/recognition/bin/pip install --no-cache-dir -r /app/recognize/requirements.txt

ENV PATH="/opt/recognition/bin:${PATH}" \
    NODE_ENV=production \
    PORT=8080 \
    MEDIA_TMP_DIR=/tmp/community-media \
    MEDIA_PROCESS_CONCURRENCY=1 \
    MEDIA_QUEUE_CAPACITY=32 \
    MEDIA_MAX_BYTES=134217728 \
    MEDIA_MAX_DURATION_SECONDS=600 \
    MEDIA_JOB_TIMEOUT_MS=900000 \
    RECOGNITION_KERNEL_FILE=/app/recognize/card_inventory.py

RUN mkdir -p /tmp/community-media \
  && chown -R node:node /app /tmp/community-media
USER node

EXPOSE 8080
CMD ["node", "server.mjs"]
