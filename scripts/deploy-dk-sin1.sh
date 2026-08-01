#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_dir="/srv/clinical-evidence-mcp"

ssh dk-sin1 "install -d -m 755 '${remote_dir}'"
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude 'node_modules/' \
  "${repo_root}/" \
  "dk-sin1:${remote_dir}/"

ssh dk-sin1 "cd '${remote_dir}' && test -f .env && docker compose config --quiet && docker compose up -d --build --remove-orphans && docker compose ps"

curl -fsS \
  --retry 12 \
  --retry-delay 5 \
  "https://clinical-evidence-mcp.danielk.am/healthz"
