FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt build-requirements.txt account-requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r build-requirements.txt \
    && pip install --no-cache-dir --require-hashes --no-build-isolation -r requirements.txt -r account-requirements.txt \
    && useradd --create-home --uid 10001 collector
COPY cloud.py ./cloud.py
COPY core/cloud_job.py core/lifecycle.py core/official_catalog.py core/regions.py core/transport.py core/http2.py core/arena.py core/demand.py ./core/
COPY core/platform_login.py core/player_login.py core/account_job.py core/guest_registration.py core/guest_job.py ./core/
COPY core/total-descriptors.pb core/intl-descriptors.pb ./core/
USER collector
EXPOSE 8080
CMD ["python", "cloud.py"]
