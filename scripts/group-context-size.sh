#!/usr/bin/env bash
# Show NanoClaw session sizes — line count and byte count of each group's
# Claude Agent SDK session jsonl. Used to gauge whether the resume payload
# is approaching the size where UND_ERR_SOCKET becomes likely.
#
# Usage:
#   scripts/group-context-size.sh             # all groups, sorted by size
#   scripts/group-context-size.sh <group>     # one group only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

HEADER_FMT="%-20s %8s %10s %10s\n"
ROW_FMT="%-20s %8d %10s %7d K\n"

print_header() {
  # shellcheck disable=SC2059
  printf "$HEADER_FMT" "GROUP" "LINES" "SIZE" "TOKENS"
}

# Print one group as: "<group>\t<bytes>\t<formatted-row>"
# bytes prefix lets the all-groups path sort by size before printing.
print_one() {
  local group="$1"
  local session_id
  session_id=$(sqlite3 "$DB" "SELECT session_id FROM sessions WHERE group_folder = '$group';")
  if [ -z "$session_id" ]; then
    printf "%s\t0\t%-20s %s\n" "$group" "$group" "(no session)"
    return
  fi
  local file="$REPO_ROOT/data/sessions/$group/.claude/projects/-workspace-group/$session_id.jsonl"
  if [ ! -f "$file" ]; then
    printf "%s\t0\t%-20s %s\n" "$group" "$group" "(jsonl missing)"
    return
  fi
  local lines bytes
  lines=$(wc -l < "$file")
  bytes=$(stat -c %s "$file")
  # Token estimate ≈ bytes / 4 (chars), then to K-tokens.
  # shellcheck disable=SC2059
  printf "%s\t%d\t$ROW_FMT" \
    "$group" "$bytes" \
    "$group" "$lines" \
    "$(numfmt --to=iec --suffix=B "$bytes")" "$((bytes / 4 / 1024))"
}

if [ $# -ge 1 ]; then
  GROUP="$1"
  if ! [[ "$GROUP" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "error: group name must match [A-Za-z0-9_-]+" >&2
    exit 1
  fi
  print_header
  print_one "$GROUP" | cut -f3-
  exit 0
fi

# All groups — sort by jsonl size descending so the heaviest sessions surface.
print_header
sqlite3 -separator $'\t' "$DB" "SELECT group_folder FROM sessions ORDER BY group_folder;" | \
  while IFS= read -r g; do
    print_one "$g"
  done | sort -t$'\t' -k2 -n -r | cut -f3-
