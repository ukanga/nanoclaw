#!/usr/bin/env bash
# Show NanoClaw session sizes — line count, total file size, and the
# *live* (post-compact) byte count that the Claude Agent SDK actually
# loads on resume. The SDK only feeds content from the last
# compact_boundary marker onward to the model; pre-boundary turns stay
# on disk for forensics.
#
# Usage:
#   scripts/group-context-size.sh             # all groups, sorted by live bytes
#   scripts/group-context-size.sh <group>     # one group only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

HEADER_FMT="%-20s %7s %10s %10s %10s %s\n"
ROW_FMT="%-20s %7d %10s %10s %7d K %s\n"

print_header() {
  # shellcheck disable=SC2059
  printf "$HEADER_FMT" "GROUP" "LINES" "TOTAL" "LIVE" "TOKENS" "STATUS"
}

# Compute post-compact bytes: everything from the line after the last
# compact_boundary marker. If no boundary is present, returns the full
# file size.
post_compact_bytes() {
  local file="$1" total_bytes="$2"
  local boundary_line
  boundary_line=$(grep -n '"subtype":"compact_boundary"' "$file" |
    tail -1 | cut -d: -f1 || true)
  if [ -z "$boundary_line" ]; then
    echo "$total_bytes"
    return
  fi
  # The boundary line itself is the marker; the SDK feeds the summary
  # (next line) plus everything after it. Slice from boundary_line+1.
  awk -v start="$((boundary_line + 1))" 'NR >= start' "$file" | wc -c
}

# Print one group as: "<group>\t<sort_key>\t<formatted-row>"
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

  local lines total_bytes live_bytes status
  lines=$(wc -l < "$file")
  total_bytes=$(stat -c %s "$file")
  live_bytes=$(post_compact_bytes "$file" "$total_bytes")
  if [ "$live_bytes" -lt "$total_bytes" ]; then
    status="compacted"
  else
    status="—"
  fi

  # Token estimate ≈ bytes / 4 / 1024, computed against the LIVE
  # bytes — that's what the model actually sees on resume.
  # shellcheck disable=SC2059
  printf "%s\t%d\t$ROW_FMT" \
    "$group" "$live_bytes" \
    "$group" "$lines" \
    "$(numfmt --to=iec --suffix=B "$total_bytes")" \
    "$(numfmt --to=iec --suffix=B "$live_bytes")" \
    "$((live_bytes / 4 / 1024))" "$status"
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

# All groups — sort by LIVE bytes descending so the heaviest *resume*
# payloads surface, not the heaviest on-disk archives.
print_header
sqlite3 -separator $'\t' "$DB" "SELECT group_folder FROM sessions ORDER BY group_folder;" | \
  while IFS= read -r g; do
    print_one "$g"
  done | sort -t$'\t' -k2 -n -r | cut -f3-
