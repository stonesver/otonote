#!/usr/bin/env bash
# Run from an immutable reviewed program directory, with external configuration.
set -euo pipefail
umask 077
for name in RENDER_MAINTENANCE_ROOT RENDER_MAINTENANCE_REPORTS RENDER_MAINTENANCE_ARCHIVES; do
  [[ -n ${!name:-} && ${!name} == /* && -d ${!name} && ! -L ${!name} ]] || {
    echo "Missing or unsafe maintenance directory: $name" >&2; exit 2;
  }
done
age_days=${RENDER_MAINTENANCE_AGE_DAYS:-7}
[[ $age_days =~ ^([1-9]|[12][0-9]|30)$ ]] || {
  echo 'RENDER_MAINTENANCE_AGE_DAYS must be between 1 and 30' >&2; exit 2;
}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
plan="$RENDER_MAINTENANCE_REPORTS/$run_id.plan.json"
archive="$RENDER_MAINTENANCE_ARCHIVES/$run_id.html.tar.gz"
python3 -m tools.render_retention plan --root "$RENDER_MAINTENANCE_ROOT" --plan "$plan" --minimum-age-days "$age_days"
if python3 - "$plan" <<'PY'
import json, sys
raise SystemExit(0 if not json.load(open(sys.argv[1]))['views'] else 1)
PY
then
  exit 0
fi
python3 -m tools.render_retention archive --root "$RENDER_MAINTENANCE_ROOT" --plan "$plan" --archive "$archive"
python3 -m tools.render_retention apply --root "$RENDER_MAINTENANCE_ROOT" --plan "$plan" --archive "$archive"
