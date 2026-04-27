#!/usr/bin/env bash
# Reset a NanoClaw group's Claude Agent SDK session.
# Use when a group hits repeated UND_ERR_SOCKET errors caused by a bloated session.
# Clears only the SQLite tracking row; on-disk session history under data/sessions/ is preserved.

set -euo pipefail

GROUP="${1:?usage: $0 <group-folder>}"

if ! [[ "$GROUP" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: group name must match [A-Za-z0-9_-]+" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

echo "Resetting session for group: $GROUP"
sqlite3 "$DB" "DELETE FROM sessions WHERE group_folder = '$GROUP';"

mapfile -t CONTAINERS < <(docker ps --filter "name=nanoclaw-${GROUP}-" --format '{{.Names}}')
if [ "${#CONTAINERS[@]}" -gt 0 ]; then
  echo "Stopping containers: ${CONTAINERS[*]}"
  docker stop "${CONTAINERS[@]}" >/dev/null
fi

echo "Done. Next message to '$GROUP' will start a fresh session."
