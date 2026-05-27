#!/usr/bin/env bash
# Show NanoClaw session sizes — one row per session, sorted by approximate
# context pressure. Cross-provider:
#
#   claude — line count, total bytes, *live* (post-compact) bytes that the
#     Claude Agent SDK feeds on resume (slice from the last compact_boundary
#     marker). Tokens are estimated as LIVE / 4 / 1024. STATUS = compacted/—.
#
#   codex  — line count, total bytes, exact `last_token_usage.input_tokens`
#     from the most recent `token_count` record in the codex rollout file.
#     STATUS = pct of model_context_window (e.g. `25%`). LIVE is left equal
#     to TOTAL — codex's auto-compaction is internal to the app-server and
#     the on-disk JSONL is append-only forensics.
#
# v2 schema notes (vs. v1):
#   - One agent group can have multiple sessions; this script reports
#     one row per session, not one per group.
#   - claude transcript dir is per-agent-group, shared by all sessions:
#       data/v2-sessions/<agent_group_id>/.claude-shared/projects/-workspace-agent/<continuation>.jsonl
#   - codex transcript dir is per-session (codex provider mounts its own
#     ~/.codex per session). File name is `rollout-<ts>-<thread_id>.jsonl`
#     under codex/sessions/YYYY/MM/DD/, found by glob on the suffix:
#       data/v2-sessions/<agent_group_id>/<session_id>/codex/sessions/**/rollout-*-<continuation>.jsonl
#   - The continuation id lives in outbound.db's `session_state` table
#     under key `continuation:<provider>` (claude or codex).
#
# Usage:
#   scripts/group-context-size.sh             # all sessions, sorted by context pressure
#   scripts/group-context-size.sh <group>     # one agent group only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/data/v2.db"
SESSIONS_DIR="$REPO_ROOT/data/v2-sessions"

if [ ! -f "$DB" ]; then
  echo "error: $DB not found" >&2
  exit 1
fi

HEADER_FMT="%-20s %-12s %7s %10s %10s %10s %s\n"
ROW_FMT="%-20s %-12s %7d %10s %10s %7d K %s\n"

print_header() {
  # shellcheck disable=SC2059
  printf "$HEADER_FMT" "GROUP" "SESSION" "LINES" "TOTAL" "LIVE" "TOKENS" "STATUS"
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

# Print one session as: "<sort_key>\t<formatted-row>". Dispatches on provider.
print_one_session() {
  local folder="$1" agent_group_id="$2" session_id="$3" provider="${4:-claude}"
  local out_db="$SESSIONS_DIR/$agent_group_id/$session_id/outbound.db"
  if [ ! -f "$out_db" ]; then
    printf "%d\t%-20s %-12s %s\n" 0 "$folder" "${session_id:0:8}" "(no outbound.db)"
    return
  fi

  local continuation
  continuation=$(sqlite3 "$out_db" \
    "SELECT value FROM session_state WHERE key = 'continuation:$provider';" 2>/dev/null || true)
  if [ -z "$continuation" ]; then
    printf "%d\t%-20s %-12s %s\n" 0 "$folder" "${session_id:0:8}" "(no continuation)"
    return
  fi

  case "$provider" in
    codex)
      print_codex_row "$folder" "$agent_group_id" "$session_id" "$continuation"
      ;;
    *)
      print_claude_row "$folder" "$agent_group_id" "$session_id" "$continuation"
      ;;
  esac
}

print_claude_row() {
  local folder="$1" agent_group_id="$2" session_id="$3" continuation="$4"
  local jsonl="$SESSIONS_DIR/$agent_group_id/.claude-shared/projects/-workspace-agent/$continuation.jsonl"
  if [ ! -f "$jsonl" ]; then
    printf "%d\t%-20s %-12s %s\n" 0 "$folder" "${session_id:0:8}" "(jsonl missing)"
    return
  fi

  local lines total_bytes live_bytes status
  lines=$(wc -l < "$jsonl")
  total_bytes=$(stat -c %s "$jsonl" 2>/dev/null || stat -f %z "$jsonl")
  live_bytes=$(post_compact_bytes "$jsonl" "$total_bytes")
  if [ "$live_bytes" -lt "$total_bytes" ]; then
    status="compacted"
  else
    status="—"
  fi

  # Token estimate ≈ bytes / 4 / 1024, computed against the LIVE
  # bytes — that's what the model actually sees on resume.
  # shellcheck disable=SC2059
  printf "%d\t$ROW_FMT" \
    "$live_bytes" \
    "$folder" "${session_id:0:8}" "$lines" \
    "$(numfmt --to=iec --suffix=B "$total_bytes")" \
    "$(numfmt --to=iec --suffix=B "$live_bytes")" \
    "$((live_bytes / 4 / 1024))" "$status"
}

print_codex_row() {
  local folder="$1" agent_group_id="$2" session_id="$3" continuation="$4"
  local jsonl
  jsonl=$(find "$SESSIONS_DIR/$agent_group_id/$session_id/codex/sessions" \
    -name "rollout-*-$continuation.jsonl" 2>/dev/null | head -1)
  if [ -z "$jsonl" ] || [ ! -f "$jsonl" ]; then
    printf "%d\t%-20s %-12s %s\n" 0 "$folder" "${session_id:0:8}" "(jsonl missing)"
    return
  fi

  local lines total_bytes last_tc last_input window status
  lines=$(wc -l < "$jsonl")
  total_bytes=$(stat -c %s "$jsonl" 2>/dev/null || stat -f %z "$jsonl")

  # Pull last `token_count` event from the rollout. Codex writes exact
  # counts per turn, so we don't have to estimate from bytes.
  last_tc=$(grep '"type":"token_count"' "$jsonl" | tail -1 || true)
  if [ -z "$last_tc" ]; then
    last_input=0
    window=0
    status="(no turns)"
  else
    last_input=$(printf '%s' "$last_tc" | sed -nE 's/.*"last_token_usage":\{"input_tokens":([0-9]+).*/\1/p')
    window=$(printf '%s' "$last_tc" | sed -nE 's/.*"model_context_window":([0-9]+).*/\1/p')
    last_input=${last_input:-0}
    window=${window:-0}
    if [ "$window" -gt 0 ]; then
      status=$(awk -v i="$last_input" -v w="$window" 'BEGIN{ printf "%d%%", (i*100)/w }')
    else
      status="—"
    fi
  fi

  # Sort key: tokens × 4 puts codex rows into the same byte-equivalent
  # magnitude as claude rows (claude's 4-bytes-per-token heuristic), so a
  # mixed table sorts by approximate context pressure across providers.
  # shellcheck disable=SC2059
  printf "%d\t$ROW_FMT" \
    "$((last_input * 4))" \
    "$folder" "${session_id:0:8}" "$lines" \
    "$(numfmt --to=iec --suffix=B "$total_bytes")" \
    "$(numfmt --to=iec --suffix=B "$total_bytes")" \
    "$((last_input / 1024))" "$status"
}

# Build the SQL filter — restricted to a single folder or all groups.
if [ $# -ge 1 ]; then
  GROUP="$1"
  if ! [[ "$GROUP" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "error: group name must match [A-Za-z0-9_-]+" >&2
    exit 1
  fi
  WHERE="WHERE ag.folder = '$GROUP'"
else
  WHERE=""
fi

print_header

# Emit "<folder>\t<agent_group_id>\t<session_id>\t<provider>" rows and
# pipe through print_one_session, sort by live bytes desc.
sqlite3 -separator $'\t' "$DB" "
  SELECT ag.folder,
         ag.id,
         s.id,
         coalesce(s.agent_provider, ag.agent_provider, 'claude')
  FROM sessions s
  JOIN agent_groups ag ON ag.id = s.agent_group_id
  $WHERE
  ORDER BY ag.folder, s.created_at DESC;" | \
  while IFS=$'\t' read -r folder agent_group_id session_id provider; do
    print_one_session "$folder" "$agent_group_id" "$session_id" "$provider"
  done | sort -t$'\t' -k1 -n -r | cut -f2-
