#!/usr/bin/env bash
# Reset a NanoClaw agent group's sessions.
# Use when an agent group hits repeated UND_ERR_SOCKET errors caused by
# a bloated session, or when you want a fresh conversation regardless
# of session_mode.
#
# v2 schema notes (vs. v1):
#   - One folder can have multiple active sessions (per messaging group
#     and thread). This script archives all of them.
#   - Sessions rows are not deleted — archiving (status='archived') is
#     FK-safe (pending_questions / pending_approvals may reference the
#     row) and equivalent for the session lookup paths, which all
#     filter on status='active'.
#   - On-disk session history under data/v2-sessions/<agent_group_id>/<session_id>/
#     is preserved. Remove manually if disk space matters.
#
# Usage:
#   scripts/reset-group-session.sh <group-folder>

set -euo pipefail

GROUP="${1:?usage: $0 <group-folder>}"

if ! [[ "$GROUP" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: group name must match [A-Za-z0-9_-]+" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/data/v2.db"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

AGENT_GROUP_ID=$(sqlite3 "$DB" "SELECT id FROM agent_groups WHERE folder = '$GROUP';")
if [ -z "$AGENT_GROUP_ID" ]; then
  echo "error: no agent group with folder '$GROUP'" >&2
  echo "known folders:" >&2
  sqlite3 "$DB" "SELECT folder FROM agent_groups ORDER BY folder;" >&2
  exit 1
fi

ACTIVE_COUNT=$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM sessions WHERE agent_group_id = '$AGENT_GROUP_ID' AND status = 'active';")
echo "Archiving $ACTIVE_COUNT active session(s) for group: $GROUP"
sqlite3 "$DB" \
  "UPDATE sessions SET status = 'archived' WHERE agent_group_id = '$AGENT_GROUP_ID' AND status = 'active';"

# v2 container naming: nanoclaw-v2-<folder>-<timestamp>
mapfile -t CONTAINERS < <(docker ps --filter "name=nanoclaw-v2-${GROUP}-" --format '{{.Names}}')
if [ "${#CONTAINERS[@]}" -gt 0 ]; then
  echo "Stopping containers: ${CONTAINERS[*]}"
  docker stop "${CONTAINERS[@]}" >/dev/null
fi

echo "Done. Next message to '$GROUP' will start a fresh session."
