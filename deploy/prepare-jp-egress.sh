#!/usr/bin/env bash
set -euo pipefail
directory=${1:?expected a private runner output directory}
[[ "$directory" == /* && "$(uname -m)" == x86_64 ]] || exit 2
install -d -m 700 "$directory"
curl --fail --location --retry 3 --silent --show-error \
  --proto '=https' --proto-redir '=https' \
  'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-linux-amd64-v1-v1.19.32.gz' \
  --output "$directory/mihomo.gz"
printf '%s  %s\n' \
  306f81e723e60ce6b828899a6fe83e1d00e9ecefb2dc8d4d849312a5bc00efdc \
  "$directory/mihomo.gz" | sha256sum --check
gzip -dc "$directory/mihomo.gz" > "$directory/mihomo"
chmod 700 "$directory/mihomo"
"$directory/mihomo" -v
