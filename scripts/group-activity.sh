#!/usr/bin/env bash
# Snapshot recent activity for a NanoClaw agent group: chat messages
# from all active sessions, host log entries scoped to this group, and
# session state.
#
# v2 schema notes (vs. v1):
#   - Group identity lives in the central DB `agent_groups` table; the
#     v1 `registered_groups` table is gone.
#   - Chat history is split across per-session DBs:
#       data/v2-sessions/<agent_group_id>/<session_id>/inbound.db   (received)
#       data/v2-sessions/<agent_group_id>/<session_id>/outbound.db  (sent)
#   - One agent group can have multiple active sessions (one per
#     messaging-group + thread). This script unions across them.
#   - Host log format is no longer pino — emit().ts writes
#     `[HH:MM:SS.ms] LEVEL msg key=val ...` with `agentGroup="<name>"`
#     or `container="<folder>"` fields we can grep on.
#
# Usage:
#   scripts/group-activity.sh <group-folder> [limit]
#
# Examples:
#   scripts/group-activity.sh nini-finance
#   scripts/group-activity.sh nini-finance 40

set -euo pipefail

GROUP="${1:?usage: $0 <group-folder> [limit]}"
LIMIT="${2:-20}"

if ! [[ "$GROUP" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: group name must match [A-Za-z0-9_-]+" >&2
  exit 1
fi
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "error: limit must be a positive integer" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/data/v2.db"
SESSIONS_DIR="$REPO_ROOT/data/v2-sessions"
LOG="$REPO_ROOT/logs/nanoclaw.log"
ERR_LOG="$REPO_ROOT/logs/nanoclaw.error.log"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

read -r AGENT_GROUP_ID DISPLAY_NAME < <(sqlite3 -separator $'\t' "$DB" \
  "SELECT id, name FROM agent_groups WHERE folder = '$GROUP' LIMIT 1;")

if [ -z "${AGENT_GROUP_ID:-}" ]; then
  echo "error: no agent group with folder '$GROUP'" >&2
  echo "known folders:" >&2
  sqlite3 "$DB" "SELECT folder FROM agent_groups ORDER BY folder;" >&2
  exit 1
fi

# Re-query name without the read-splitting (in case name has tabs).
DISPLAY_NAME=$(sqlite3 "$DB" "SELECT name FROM agent_groups WHERE id = '$AGENT_GROUP_ID';")

hr() { printf '\n=== %s ===\n' "$1"; }

hr "Agent group"
printf 'folder       : %s\n' "$GROUP"
printf 'name         : %s\n' "$DISPLAY_NAME"
printf 'agent_group_id : %s\n' "$AGENT_GROUP_ID"

hr "Sessions"
sqlite3 -box "$DB" "
  SELECT substr(s.id, 1, 24) AS session_id,
         s.status,
         s.container_status AS container,
         coalesce(mg.channel_type, '-') AS channel,
         coalesce(mg.name, mg.platform_id, '-') AS messaging_group,
         coalesce(s.thread_id, '-') AS thread,
         coalesce(s.last_active, '-') AS last_active
  FROM sessions s
  LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
  WHERE s.agent_group_id = '$AGENT_GROUP_ID'
  ORDER BY s.created_at DESC;"

# Gather session IDs to walk for chat history.
mapfile -t SESSION_IDS < <(sqlite3 "$DB" \
  "SELECT id FROM sessions WHERE agent_group_id = '$AGENT_GROUP_ID' ORDER BY created_at DESC;")

hr "Last $LIMIT messages across all sessions (chronological)"
if [ "${#SESSION_IDS[@]}" -eq 0 ]; then
  echo "(no sessions)"
else
  # Build a unified timeline by extracting (timestamp, who, preview) from
  # each session's inbound + outbound DBs, then sort and take the tail.
  {
    for SID in "${SESSION_IDS[@]}"; do
      SDIR="$SESSIONS_DIR/$AGENT_GROUP_ID/$SID"
      IN_DB="$SDIR/inbound.db"
      OUT_DB="$SDIR/outbound.db"
      if [ -f "$IN_DB" ]; then
        sqlite3 -separator $'\t' "$IN_DB" "
          SELECT timestamp,
                 'user' || ' [' || substr('$SID', 1, 8) || ']',
                 substr(replace(content, char(10), ' '), 1, 70)
          FROM messages_in
          ORDER BY timestamp DESC LIMIT $LIMIT;" 2>/dev/null || true
      fi
      if [ -f "$OUT_DB" ]; then
        sqlite3 -separator $'\t' "$OUT_DB" "
          SELECT timestamp,
                 'agent [' || substr('$SID', 1, 8) || ']',
                 substr(replace(content, char(10), ' '), 1, 70)
          FROM messages_out
          ORDER BY timestamp DESC LIMIT $LIMIT;" 2>/dev/null || true
      fi
    done
  } | sort -t$'\t' -k1 | tail -n "$LIMIT" | \
    awk -F'\t' '{ printf "%-23s  %-26s  %s\n", $1, $2, $3 }'
fi

# v2 log format: `[HH:MM:SS.ms] LEVEL msg key=val ...`
# Group identity appears as either `agentGroup="<name>"` (lifecycle events)
# or `container="<folder>"` (stderr lines from spawned containers).
log_lines_for_group() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -E "agentGroup=\"$DISPLAY_NAME\"|container=\"$GROUP\"" "$file" || true
}

hr "Recent agent runs (last $LIMIT)"
if [ -f "$LOG" ]; then
  log_lines_for_group "$LOG" \
    | grep -E "Spawning container|Container exited|Container spawn error|Killing container|OneCLI gateway|Per-agent-group image" \
    | tail -n "$LIMIT"
else
  echo "(no host log at $LOG — check journalctl --user -u nanoclaw on Linux)"
fi

hr "Recent errors (last $LIMIT)"
{
  log_lines_for_group "$ERR_LOG"
  log_lines_for_group "$LOG" | grep -E "ERROR|WARN" || true
} | tail -n "$LIMIT"

hr "Group folder"
GROUP_DIR="$REPO_ROOT/groups/$GROUP"
if [ -d "$GROUP_DIR" ]; then
  printf 'path         : %s\n' "$GROUP_DIR"
  for d in inbox outbox receipts; do
    if [ -d "$GROUP_DIR/$d" ]; then
      printf '%-12s : %d entries\n' "$d" "$(find "$GROUP_DIR/$d" -maxdepth 1 -mindepth 1 | wc -l)"
    fi
  done
else
  printf 'path         : (missing)\n'
fi
