#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_IMAGE="${OURNOTES_WORKER_IMAGE:-ournotes-resource-worker:local}"
QUERY_IMAGE="${OURNOTES_QUERY_IMAGE:-ournotes-query:local}"
QUERY_VENV="${OURNOTES_QUERY_VENV:-/tmp/ournotes-query-venv}"
WORKER_NODE_BASE_IMAGE="${OURNOTES_WORKER_NODE_BASE_IMAGE:-node:22.23.4-bookworm-slim}"
QUERY_PYTHON_BASE_IMAGE="${OURNOTES_QUERY_PYTHON_BASE_IMAGE:-python:3.11-slim-bookworm}"
export ASTRO_TELEMETRY_DISABLED=1

cd "$REPO_ROOT"

# --- Shared Python verification environment ---------------------------------
# Query HTTP tests need FastAPI, while the remaining test lane may rely on
# Worker packages already installed in the caller's Python environment. A venv
# with system-site-packages keeps those lanes compatible without modifying the
# system interpreter.
if [[ ! -d "$QUERY_VENV" ]]; then
  echo "==> provisioning query service venv at $QUERY_VENV"
fi
python3 -m venv --system-site-packages "$QUERY_VENV"
"$QUERY_VENV/bin/pip" install --require-hashes -r tools/python-security-requirements.txt
"$QUERY_VENV/bin/pip" install --quiet --requirement requirements-query.txt

python3 tools/docs_status.py
python3 -m tools.artifact_registry --root site/src/data/generated
"$QUERY_VENV/bin/python" -m unittest discover -s tests -v

# --- Query Service local verification ----------------------------------------
"$QUERY_VENV/bin/python" -m unittest \
  tests.test_query_contracts \
  tests.test_content_query_projection \
  tests.test_dataset_query \
  tests.test_query_http \
  tests.test_identity_binding \
  tests.test_identity_backup \
  tests.test_query_delivery \
  tests.test_query_capacity_check \
  tests.test_nginx_contract \
  -v

if [[ "${OURNOTES_SKIP_DOCKER_BUILD:-0}" == "1" ]]; then
  cd "$REPO_ROOT/site"
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 20)) { throw new Error("Node >=22.20.0 is required"); }'
  if [[ "${CI:-}" == "true" || ! -d node_modules ]]; then
    npm ci
  fi
  npm run catalog:preflight
  node --test tests/*.test.mjs
  npm exec -- astro check
  CI_BUILD_ROOT="$REPO_ROOT/output/release-builds/ci-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  npm run build -- --output "$CI_BUILD_ROOT"
  CI_DIST="$CI_BUILD_ROOT/site"
  cd "$REPO_ROOT"
  OURNOTES_TEST_DIST="$CI_DIST" python3 -m unittest discover -s tests -p 'test_browser_regression.py' -v
  cd "$REPO_ROOT/site"
  python3 ../tools/performance_budget.py "$CI_DIST" --output ../output/readiness/build-budget.json
  cd "$REPO_ROOT"
  CI_GIT_COMMIT="$(git rev-parse HEAD)"
  CI_GIT_SHORT="${CI_GIT_COMMIT:0:12}"
  python3 -m tools.site_artifact build \
    --artifact-root "$CI_DIST" \
    --release-index "$CI_DIST/global/zh-CN/data/release-index.json" \
    --package-lock "$REPO_ROOT/site/package-lock.json" \
    --media-index "$CI_DIST/global/zh-CN/data/media-index.json" \
    --site-release-id "ci-${CI_GIT_SHORT}" \
    --git-commit "$CI_GIT_COMMIT" \
    --docker-image "ci-local:${CI_GIT_SHORT}" \
    --built-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 -m tools.site_artifact verify \
    --artifact-root "$CI_DIST" \
    --expected-git-commit "$CI_GIT_COMMIT" \
    --package-lock "$REPO_ROOT/site/package-lock.json" \
    --release-index "$CI_DIST/global/zh-CN/data/release-index.json"
  PERFORMANCE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  "$REPO_ROOT/tools/run_performance_gate.sh" --dist "$CI_DIST"
  CI_EVIDENCE_MODE="local-runtime"
else
  cd "$REPO_ROOT"
  docker build --file Dockerfile.worker \
    --build-arg NODE_BASE_IMAGE="$WORKER_NODE_BASE_IMAGE" \
    --tag "$WORKER_IMAGE" \
    .
  docker build --file Dockerfile.query \
    --build-arg PYTHON_BASE_IMAGE="$QUERY_PYTHON_BASE_IMAGE" \
    --tag "$QUERY_IMAGE" \
    .

  # Offline Query Service smoke: spin up the image against a fixture
  # data directory and hit the loopback health endpoints via the venv's
  # httpx client. The smoke is fixture-only — it never talks to the
  # public site or the upstream game servers.
  QUERY_SMOKE_ROOT="$(mktemp -d)"
  mkdir -p \
    "$QUERY_SMOKE_ROOT/releases" \
    "$QUERY_SMOKE_ROOT/identity" \
    "$QUERY_SMOKE_ROOT/identity-backups"
  chmod 0777 "$QUERY_SMOKE_ROOT/identity" "$QUERY_SMOKE_ROOT/identity-backups"
  docker run --rm \
    --detach \
    --name ournotes-query-smoke \
    --publish 127.0.0.1:18090:8090 \
    --env OURNOTES_DATA_ROOT=/data \
    --env OURNOTES_QUERY_HOST=127.0.0.1 \
    --env OURNOTES_QUERY_PORT=8090 \
    --env OURNOTES_QUERY_ENABLED_ENVIRONMENTS=global-production \
    --mount type=bind,source="$QUERY_SMOKE_ROOT/releases",target=/data/releases,readonly \
    --mount type=bind,source="$QUERY_SMOKE_ROOT/identity",target=/data/identity \
    "$QUERY_IMAGE" >/dev/null
  trap 'docker rm --force ournotes-query-smoke >/dev/null 2>&1 || true; rm -rf "$QUERY_SMOKE_ROOT"' EXIT
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if "$QUERY_VENV/bin/python" -c "
import sys
import httpx
try:
    r = httpx.get('http://127.0.0.1:18090/api/v1/health/live', timeout=2.0)
    sys.exit(0 if r.status_code == 200 else 1)
except Exception:
    sys.exit(1)
"; then
      break
    fi
    sleep 1
  done
  "$QUERY_VENV/bin/python" - <<'PY'
import sys
import httpx

base = "http://127.0.0.1:18090"
client = httpx.Client(base_url=base, timeout=5.0)

def assert_status(path, expected):
    response = client.get(path)
    if response.status_code != expected:
        raise SystemExit(f"smoke failed: {path} -> {response.status_code}")
    return response

assert_status("/api/v1/health/live", 200)
# Fixture has no releases published so readiness is 503 by design.
ready = assert_status("/api/v1/health/ready", 503)
if ready.json().get("status") != "not_ready":
    raise SystemExit("smoke failed: readiness payload mismatch")
# A public query against an unknown env must still return a 200 envelope.
events = client.get(
    "/api/v1/events",
    params={"region": "global", "channel": "production", "locale": "ja"},
)
if events.status_code != 200:
    raise SystemExit(f"smoke failed: events -> {events.status_code}")
if events.json().get("dataset") != "events":
    raise SystemExit("smoke failed: events payload mismatch")
print("query smoke ok")
PY
  docker run --rm \
    --name ournotes-query-backup-smoke \
    --mount type=bind,source="$QUERY_SMOKE_ROOT/identity",target=/data/identity \
    --mount type=bind,source="$QUERY_SMOKE_ROOT/identity-backups",target=/data/backups \
    "$QUERY_IMAGE" \
    python3 -m backend.identity_backup \
      --source-path /data/identity/identity.sqlite3 \
      --backup-root /data/backups
  test -s "$QUERY_SMOKE_ROOT/identity-backups/identity-latest.sqlite3"
  docker rm --force ournotes-query-smoke >/dev/null 2>&1 || true
  trap - EXIT
  rm -rf "$QUERY_SMOKE_ROOT"

  docker run --rm \
    --volume "$REPO_ROOT/site/src/data/generated:/app/site/src/data/generated" \
    --volume "$REPO_ROOT/site/public/data:/app/site/public/data" \
    --volume "$REPO_ROOT/site/public/media:/app/site/public/media" \
    --entrypoint sh \
    "$WORKER_IMAGE" \
    -ec '
    test "$(node --version)" = "v22.23.4"
    python3 -c "import UnityPy"
    ffmpeg -version >/dev/null
    ffprobe -version >/dev/null
    if command -v gcc >/dev/null 2>&1; then
      echo "Compiler leaked into the runtime Worker image." >&2
      exit 1
    fi
    cd /app
    python3 -m tools.resource_pipeline.cli run \
      --all-enabled \
      --data-root /tmp/ournotes-worker-smoke
  '
  CI_EVIDENCE_MODE="worker-container"
fi

CI_EVIDENCE_ARGS=(--mode "$CI_EVIDENCE_MODE")
if [[ "$CI_EVIDENCE_MODE" == "local-runtime" ]]; then
  CI_EVIDENCE_ARGS+=(
    --artifact-root "$CI_DIST"
    --performance-contract "$REPO_ROOT/config/performance/gates.product-v1.json"
    --performance-baseline "$REPO_ROOT/output/readiness/global-browser-baseline.json"
    --browser-performance-report "$REPO_ROOT/output/readiness/performance-browser.json"
    --load-curve-report "$REPO_ROOT/output/readiness/performance-load-curve.json"
    --performance-not-before "$PERFORMANCE_STARTED_AT"
  )
fi
python3 "$REPO_ROOT/tools/ci_evidence.py" "${CI_EVIDENCE_ARGS[@]}"
