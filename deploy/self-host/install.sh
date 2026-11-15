#!/usr/bin/env bash
# TManage self-host installer (54-19): fetch the kit, verify it, unpack it, run `tmanage install`.
#
#   bash install.sh <kit URL or file> <sha256> [install dir, default /opt/tmanage]
#
# The SHA-256 is the one published with the release over HTTPS; the kit is refused without a
# match. Needs Docker (with the compose plugin), curl, tar and sha256sum. All the work after the
# download is ./tmanage's: this script only gets a verified kit onto the box.
set -euo pipefail

src="${1:?usage: bash install.sh <kit URL or file> <sha256> [install dir]}"
sha="${2:?usage: bash install.sh <kit URL or file> <sha256> [install dir]}"
dest="${3:-/opt/tmanage}"

command -v docker > /dev/null || { echo "install.sh: install Docker first (README.en.md)" >&2; exit 1; }
docker compose version > /dev/null || { echo "install.sh: the docker compose plugin is missing" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ -f "$src" ]]; then
  cp "$src" "$tmp/kit.tar.gz"
else
  [[ "$src" == https://* ]] || { echo "install.sh: download only over https" >&2; exit 1; }
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/kit.tar.gz" "$src"
fi
[[ "$(sha256sum "$tmp/kit.tar.gz" | awk '{print $1}')" == "${sha,,}" ]] \
  || { echo "install.sh: SHA-256 mismatch; the kit was not installed" >&2; exit 1; }
echo "Kit verified (SHA-256)."

mkdir -p "$dest"
[[ ! -e "$dest/tmanage.env" ]] || { echo "install.sh: $dest is already installed; use $dest/tmanage update" >&2; exit 1; }
tar -xzf "$tmp/kit.tar.gz" -C "$dest" --strip-components=1
chmod 700 "$dest"
chmod +x "$dest/tmanage"
exec "$dest/tmanage" install
