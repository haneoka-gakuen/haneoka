FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt build-requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r build-requirements.txt \
    && pip install --no-cache-dir --require-hashes --no-build-isolation -r requirements.txt \
    && useradd --create-home --uid 10001 collector
COPY cloud.py ./cloud.py
COPY core/cloud_job.py core/lifecycle.py core/official_catalog.py core/regions.py core/transport.py core/http2.py core/arena.py core/demand.py ./core/
COPY core/total-descriptors.pb core/intl-descriptors.pb ./core/
USER collector
EXPOSE 8080
CMD ["python", "cloud.py"]
