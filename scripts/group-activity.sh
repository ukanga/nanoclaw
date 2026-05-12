#!/usr/bin/env bash
# Snapshot recent activity for a NanoClaw group: chat messages, agent
# runs from the log, session state, and recent errors.
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
DB="$REPO_ROOT/store/messages.db"
LOG="$REPO_ROOT/logs/nanoclaw.log"
ERR_LOG="$REPO_ROOT/logs/nanoclaw.error.log"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

read -r CHAT_JID DISPLAY_NAME < <(sqlite3 -separator ' ' "$DB" \
  "SELECT jid, name FROM registered_groups WHERE folder = '$GROUP' LIMIT 1;")

if [ -z "${CHAT_JID:-}" ]; then
  echo "error: no registered group with folder '$GROUP'" >&2
  echo "known folders:" >&2
  sqlite3 "$DB" "SELECT folder FROM registered_groups ORDER BY folder;" >&2
  exit 1
fi

# Display name may contain spaces — the read above only captured the first
# token. Re-query for the full name.
DISPLAY_NAME=$(sqlite3 "$DB" "SELECT name FROM registered_groups WHERE folder = '$GROUP';")

hr() { printf '\n=== %s ===\n' "$1"; }

hr "Group"
printf 'folder       : %s\n' "$GROUP"
printf 'name         : %s\n' "$DISPLAY_NAME"
printf 'chat_jid     : %s\n' "$CHAT_JID"
SESSION_ID=$(sqlite3 "$DB" "SELECT session_id FROM sessions WHERE group_folder = '$GROUP';" || true)
printf 'session_id   : %s\n' "${SESSION_ID:-<none>}"

hr "Last $LIMIT messages (chronological)"
sqlite3 -box "$DB" "
  SELECT timestamp AS ts,
         CASE WHEN is_from_me=1 THEN '(me)' ELSE substr(sender_name,1,18) END AS who,
         substr(replace(content, char(10), ' '), 1, 70) AS preview
  FROM (
    SELECT * FROM messages
    WHERE chat_jid = '$CHAT_JID'
    ORDER BY timestamp DESC LIMIT $LIMIT
  )
  ORDER BY timestamp ASC;"

# Pino splits a log event across lines: the message+timestamp on one line
# and indented attributes (`    group: "Nini Finance"`) on the next. The
# pino-pretty output is also wrapped in ANSI color escapes, so we strip
# those first, then print each event whose attributes include the group.
event_lines_for_group() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed 's/\x1b\[[0-9;]*m//g' "$file" | awk -v g="\"$DISPLAY_NAME\"" '
    /^\[/ {
      if (header && matched) print header
      header = $0; matched = 0; next
    }
    /^    group:/ { if (index($0, g)) matched = 1 }
    END { if (header && matched) print header }
  '
}

hr "Recent agent runs (last $LIMIT)"
event_lines_for_group "$LOG" \
  | { grep -E "Spawning container agent|Agent output|Signal message sent|Container completed|Container timed out|Container agent error|Retrying after SDK|SDK API socket error" || true; } \
  | tail -n "$LIMIT" \
  | sed 's/\x1b\[[0-9;]*m//g'

hr "Recent errors (last $LIMIT)"
{
  event_lines_for_group "$ERR_LOG"
  event_lines_for_group "$LOG" | grep -E "ERROR|WARN" || true
} | tail -n "$LIMIT" | sed 's/\x1b\[[0-9;]*m//g'

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
