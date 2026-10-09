# Pin a clean Python 3.11 base by digest. Do not derive from an older capture
# image: private SDK resources would remain recoverable in inherited layers.
ARG BASE_IMAGE=python:3.11-slim-bookworm
FROM ${BASE_IMAGE}
USER root
WORKDIR /app
COPY tools/growth-export-requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt
COPY backend/__init__.py backend/player_rankings.py /app/backend/
COPY tools/collect_player_rankings.py tools/growth_login.py tools/growth_export.py tools/import_player_rankings.py /app/tools/
COPY tools/resource_pipeline/__init__.py tools/resource_pipeline/localization.py tools/resource_pipeline/models.py /app/tools/resource_pipeline/
# SDK resources and account credentials are supplied only as runtime read-only mounts.
RUN mkdir -p /data/observations/global-hmt /state /run/ranking-credentials /run/ranking-sdk
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CREDENTIALS_DIRECTORY=/run/ranking-credentials
USER 10001:10001
ENTRYPOINT ["python", "-m", "tools.collect_player_rankings"]
