#!/usr/bin/env bash
# Read-only inputs; only bounded health state is writable.
set -euo pipefail
: "${R2_PRERENDER_IMAGE:?}"
: "${R2_HEALTH_ROOT:=/srv/ournotes-update-health}"
: "${R2_HEALTH_BUDGET_BYTES:=4026531840}"
[[ $R2_PRERENDER_IMAGE =~ ^sha256:[a-f0-9]{64}$ || $R2_PRERENDER_IMAGE =~ @sha256:[a-f0-9]{64}$ ]] || exit 2
[[ $R2_HEALTH_BUDGET_BYTES =~ ^[1-9][0-9]*$ ]] || exit 2
exec 9>/var/lib/ournotes-resource-state/.update-health.lock
flock -n 9 || exit 0
python3 /usr/local/libexec/ournotes/export_ranking_health.py
python3 /usr/local/libexec/ournotes/worker_health.py
exec docker run --rm --read-only --network bridge --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 256m --memory-swap 256m --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  --env PYTHONDONTWRITEBYTECODE=1 --env PYTHONPATH=/health \
  --env R2_ACCOUNT_ID --env R2_ACCESS_KEY_ID --env R2_SECRET_ACCESS_KEY --env R2_PUBLIC_BUCKET \
  --mount "type=bind,source=$R2_HEALTH_ROOT/tools,target=/health/tools,readonly" \
  --mount type=bind,source=/var/lib/ournotes-resource-state,target=/state \
  "$R2_PRERENDER_IMAGE" python3 -m tools.update_health \
  --delivery /state/latest-run.json --ranking /state/ranking-health.json --disk /state \
  --worker /state/worker-health.json --budget "$R2_HEALTH_BUDGET_BYTES" --output /state/update-health.json
