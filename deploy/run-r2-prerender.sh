#!/usr/bin/env bash
# Example host wrapper. Install only after the old prerender timer is stopped.
set -euo pipefail

CODE_ROOT=/srv/ournotes-code
CONTENT_ROOT=/srv/ournotes-r2-prerender-content
RENDERED_ROOT=/srv/ournotes-rendered

for name in R2_PRERENDER_IMAGE R2_PRERENDER_SOURCE_REVISION \
  R2_PRERENDER_DOCKER_FREE_BYTES R2_PRERENDER_CONTENT_FREE_BYTES \
  R2_PRERENDER_RENDERED_FREE_BYTES R2_PRERENDER_UID R2_PRERENDER_GID \
  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_BUCKET; do
  [[ -n ${!name:-} ]] || { echo "Missing $name" >&2; exit 2; }
done
if [[ $R2_PRERENDER_IMAGE =~ ^sha256:[a-f0-9]{64}$ ]]; then
  # Docker load of an archive preserves the immutable image ID, but usually
  # does not restore the registry RepoDigest. This path never pulls GHCR.
  local_image=true
elif [[ $R2_PRERENDER_IMAGE =~ ^[^[:space:]]+@sha256:[a-f0-9]{64}$ ]]; then
  local_image=false
else
  echo 'Image must be a registry digest or a loaded immutable image ID' >&2
  exit 2
fi
[[ $R2_PRERENDER_SOURCE_REVISION =~ ^[a-f0-9]{40,64}$ ]] || exit 2
[[ $R2_PUBLIC_BUCKET == otonote-public-content ]] || exit 2
for value in "$R2_PRERENDER_DOCKER_FREE_BYTES" "$R2_PRERENDER_CONTENT_FREE_BYTES" \
  "$R2_PRERENDER_RENDERED_FREE_BYTES" "$R2_PRERENDER_UID" "$R2_PRERENDER_GID"; do
  [[ $value =~ ^[0-9]+$ ]] || exit 2
done
for directory in "$CODE_ROOT" "$CONTENT_ROOT" "$RENDERED_ROOT"; do
  [[ -d $directory && ! -L $directory ]] || { echo "Invalid directory: $directory" >&2; exit 2; }
done
[[ -L $CODE_ROOT/current ]] || { echo 'Code current release is missing' >&2; exit 2; }

# The old service does not use this lock; it must be stopped before enabling
# this wrapper. Fail closed while either old unit is still active.
if systemctl is-active --quiet ournotes-prerender.timer || \
   systemctl is-active --quiet ournotes-prerender.service; then
  echo 'Stop the old prerender timer/service before running the R2 wrapper' >&2
  exit 2
fi
exec 9>"$RENDERED_ROOT/.r2-prerender.lock"
flock -n 9 || { echo 'Another R2 prerender is running' >&2; exit 2; }

docker_root=$(docker info --format '{{.DockerRootDir}}')
[[ -d $docker_root ]] || { echo 'Docker root is missing' >&2; exit 2; }

check_space() {
  # Sum simultaneous requirements for paths sharing a filesystem.
  local entry path bytes device free
  local -A required=() path_for_device=()
  for entry in "$@"; do
    path=${entry%:*}
    bytes=${entry##*:}
    device=$(stat -c %d "$path")
    required[$device]=$(( ${required[$device]:-0} + bytes ))
    path_for_device[$device]=$path
  done
  for device in "${!required[@]}"; do
    path=${path_for_device[$device]}
    free=$(df -PB1 "$path" | awk 'NR == 2 { print $4 }')
    [[ $free =~ ^[0-9]+$ ]] || { echo "Cannot measure free space: $path" >&2; return 2; }
    if (( free < required[$device] )); then
      echo "Insufficient space on $path: $free free, ${required[$device]} required" >&2
      return 2
    fi
  done
}

docker_required=0
if ! docker image inspect "$R2_PRERENDER_IMAGE" >/dev/null 2>&1; then
  [[ $local_image == false ]] || { echo 'Loaded image ID is missing' >&2; exit 2; }
  docker_required=$R2_PRERENDER_DOCKER_FREE_BYTES
fi
# Download/unpack and first materialization may occur in the same filesystem.
check_space "$docker_root:$docker_required" "$CONTENT_ROOT:$R2_PRERENDER_CONTENT_FREE_BYTES"

# Only now may Docker download/unpack the pinned image.
if [[ $local_image == true ]]; then
  docker image inspect "$R2_PRERENDER_IMAGE" >/dev/null
else
  docker image inspect "$R2_PRERENDER_IMAGE" >/dev/null 2>&1 || docker pull "$R2_PRERENDER_IMAGE"
fi
actual_revision=$(docker image inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$R2_PRERENDER_IMAGE")
[[ $actual_revision == "$R2_PRERENDER_SOURCE_REVISION" ]] || {
  echo 'R2 prerender image revision does not match the reviewed source' >&2
  exit 2
}

common=(--rm --read-only --user "$R2_PRERENDER_UID:$R2_PRERENDER_GID"
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
  --memory 1g --memory-swap 1536m --tmpfs /tmp:rw,nosuid,nodev,size=128m
  --env HOME=/tmp --env PYTHONDONTWRITEBYTECODE=1)

# Only this container receives the bucket-scoped read credential. Its writable
# mount is an independent local prerender input store, never the Nginx store.
docker run "${common[@]}" --network bridge \
  --env R2_ACCOUNT_ID --env R2_ACCESS_KEY_ID \
  --env R2_SECRET_ACCESS_KEY --env R2_PUBLIC_BUCKET \
  --mount "type=bind,source=$CONTENT_ROOT,target=/content" \
  "$R2_PRERENDER_IMAGE" python3 -m tools.materialize_r2_content \
  --store /content --region all

[[ -f $CONTENT_ROOT/current.json && -f $CONTENT_ROOT/jp/current.json ]] || {
  echo 'Both R2 region pointers are required before prerendering' >&2
  exit 2
}

mounts=(--mount "type=bind,source=$CODE_ROOT,target=/code,readonly"
  --mount "type=bind,source=$CONTENT_ROOT,target=/content,readonly"
  --mount "type=bind,source=$RENDERED_ROOT,target=/rendered")

# Existing sealed HTML can already match the newly materialized R2 pointers.
# Check both regions and their essential files before allocating a new stage.
if docker run "${common[@]}" --network none "${mounts[@]}" \
  "$R2_PRERENDER_IMAGE" python3 /app/deploy/promote_r2_prerender.py \
  --check-current --code-root /code --content /content --rendered /rendered; then
  exit 0
fi

# Only a changed or damaged view needs transient HTML space.
check_space "$RENDERED_ROOT:$R2_PRERENDER_RENDERED_FREE_BYTES"
stage=$(mktemp -d "$RENDERED_ROOT/.r2-stage-XXXXXXXX")
cleanup() {
  if [[ -n ${stage:-} && $stage == "$RENDERED_ROOT"/.r2-stage-* && -d $stage ]]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup EXIT
chown "$R2_PRERENDER_UID:$R2_PRERENDER_GID" "$stage"

# The publisher may remove its current link after a persistent failure. Run
# it only against a fresh stage; live HTML remains untouched on that failure.
docker run "${common[@]}" --network none "${mounts[@]}" \
  "$R2_PRERENDER_IMAGE" python3 -m tools.publish_prerender \
  --code-root /code --content /content --output "/rendered/${stage##*/}" --region all

# Revalidate both complete records and promote under this wrapper's lock.
# No bucket credential is passed to the renderer or promoter.
docker run "${common[@]}" --network none "${mounts[@]}" \
  "$R2_PRERENDER_IMAGE" python3 /app/deploy/promote_r2_prerender.py \
  --code-root /code --content /content --stage "/rendered/${stage##*/}" \
  --rendered /rendered
