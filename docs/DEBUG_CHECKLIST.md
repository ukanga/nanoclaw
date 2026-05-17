# NanoClaw Debug Checklist

Triage steps for "something's wrong with my install." Architecture-level
detail lives in the docs linked under [Where to look for deep dives](#where-to-look-for-deep-dives);
this file is the symptom-first index.

> **Service-name slugging:** v2's service unit is per-install. The
> launchd Label is `com.nanoclaw-v2-<slug>` and the systemd unit is
> `nanoclaw-v2-<slug>.service`, where `<slug>` is the first 8 hex chars
> of `sha1(projectRoot)` (see [`src/install-slug.ts`](../src/install-slug.ts)).
> Discover yours with `launchctl list | grep nanoclaw-v2-` (macOS) or
> `systemctl --user list-units 'nanoclaw-v2-*'` (Linux). Examples below
> use `<slug>` as a placeholder.

## Quick status check

```bash
# 1. Is the service running?
# macOS
launchctl list | grep nanoclaw-v2-
# Linux
systemctl --user list-units 'nanoclaw-v2-*'

# 2. Any active containers?
docker ps --format '{{.Names}} {{.Status}}' | grep nanoclaw-v2-

# 3. Recent errors in service log?
grep -E '\bERROR\b|\bWARN\b' logs/nanoclaw.log | tail -20

# 4. Recent stderr (warnings live here too)
tail -50 logs/nanoclaw.error.log

# 5. Sessions known to the host
sqlite3 data/v2.db \
  "SELECT id, agent_group_id, status, container_status, last_active
     FROM sessions WHERE status='active' ORDER BY last_active DESC;"
```

Log format (set by [`src/log.ts`](../src/log.ts)): `[HH:MM:SS.ms] LEVEL msg key=val …`,
with `agentGroup="<name>"` / `containerName="<…>"` / `sessionId="<…>"`
fields where applicable.

## Known issues

### 1. Kubernetes image GC deletes the agent image

**Symptom:** `Container exited with code 125: pull access denied for nanoclaw-agent-v2-<slug>` —
the image is gone overnight even though you just built it.

**Cause:** If a Kubernetes runtime is enabled (Rancher Desktop turns it
on by default), kubelet runs image garbage collection above 85% disk
usage. NanoClaw containers are `--rm`, so the image never has a running
container protecting it.

**Fix:** Disable Kubernetes if you don't need it:

```bash
rdctl set --kubernetes-enabled=false      # Rancher Desktop
./container/build.sh                      # rebuild
```

**Diagnosis:**

```bash
# What was deleted, when (Rancher Desktop)
grep -i "nanoclaw" ~/Library/Logs/rancher-desktop/k3s.log
```

If you need Kubernetes, point `CONTAINER_IMAGE` at a registry-backed
image the kubelet won't GC.

### 2. Signal attachment download silent failure

**Symptom:** Signal user sends an image; the agent reacts as if no image
was attached. The user gets no inbound at all when the envelope only
carried attachments.

**Cause:** `signal-cli` can leave a 0-byte placeholder in
`~/.local/share/signal-cli/attachments` when the CDN fetch fails.
[`src/channels/signal.ts`](../src/channels/signal.ts) drops oversize,
unreadable, and 0-byte attachments, and skips the envelope entirely
when text + voice are empty and every attachment was rejected — so the
agent is never woken with empty content.

**Diagnosis:**

```bash
grep "Signal: attachment download failed\|0-byte placeholder\|attachment was 0 bytes" \
  logs/nanoclaw.log | tail
```

**Recovery:** ask the sender to resend (the rejected attachment never
hit `inbound.db`). If this is repeating, restart `signal-cli` and check
network reachability to Signal's CDN.

### 3. UND_ERR_SOCKET / API retry storms

**Symptom:** Agent turns hang or fail with `UND_ERR_SOCKET`, ECONNRESET,
or similar transport errors against `api.anthropic.com`.

**v2 recovery layers (built-in, in this order):**

1. **SDK internal retry.** `@anthropic-ai/claude-agent-sdk` emits an
   `api_retry` system message with `attempt` / `max_retries` /
   `retry_delay_ms` and retries internally. The container surfaces it
   as `[poll-loop] Error: API retry (retryable: true)` — informational,
   not actionable.
2. **Host sweep.** If the SDK gives up and the container goes quiet,
   [`src/host-sweep.ts`](../src/host-sweep.ts) kills the container when:
   - heartbeat file mtime exceeds `ABSOLUTE_CEILING_MS` (30 min, extended
     while a Bash tool call declares a longer timeout), **or**
   - a `messages_in` row sits in `processing` for more than
     `CLAIM_STUCK_MS` (60 s, same Bash extension).
3. **Retry with backoff.** Killed-container claims are reset to `pending`
   with `tries++` and a backoff delay. After `MAX_TRIES = 5` the row is
   marked `failed`.

**Diagnosis:**

```bash
# SDK-level retries (informational)
grep "API retry\|api_retry" logs/nanoclaw.log

# Host-sweep kills (actionable)
grep -E "Killing container past absolute ceiling|Killing container — message claimed then silent|Reset stale message with backoff|marked as failed after max retries" \
  logs/nanoclaw.log
```

**Manual reset** for a bloated session that keeps tripping retries —
see [`scripts/reset-group-session.sh`](../scripts/reset-group-session.sh).

## Agent not responding

```bash
# Is the message in the host DB at all? (per agent group)
sqlite3 "data/v2-sessions/<agent_group_id>/<session_id>/inbound.db" \
  "SELECT id, kind, status, tries, timestamp
     FROM messages_in ORDER BY seq DESC LIMIT 10;"

# Did the container ever pick it up?
grep -E "Spawning container|Container exited|Killing container" logs/nanoclaw.log | tail

# Was a wake actually attempted?
grep "Waking container for due messages" logs/nanoclaw.log | tail

# What did the agent write back?
sqlite3 "data/v2-sessions/<agent_group_id>/<session_id>/outbound.db" \
  "SELECT id, kind, created_at, substr(content, 1, 120) FROM messages_out
     ORDER BY seq DESC LIMIT 10;"
```

The same data with one-shot helpers:
- [`scripts/group-activity.sh <group-folder>`](../scripts/group-activity.sh) — chat + host log for one agent group
- [`scripts/group-context-size.sh`](../scripts/group-context-size.sh) — SDK transcript live bytes per session

## Container mount issues

```bash
# Mount validation log lines (host emits on every spawn)
grep -E "Mount validated|Mount.*REJECTED|mount" logs/nanoclaw.log | tail

# External allowlist (lives outside project root; never mounted)
cat ~/.config/nanoclaw/mount-allowlist.json

# Per-group container config (on disk, not in DB)
cat groups/<folder>/container.json
```

See [`src/modules/mount-security/`](../src/modules/mount-security/) for
the validator and [SECURITY.md](SECURITY.md) for the threat model.

## Channel auth issues

Auth is per-channel in v2 — there is no single `npm run auth`. To
re-authenticate a channel, re-run its add-skill:

| Channel | Re-auth |
| ------- | ------- |
| Signal | `/add-signal` (re-pair via captcha) |
| WhatsApp | `/add-whatsapp` (re-scan QR) |
| Telegram | `/add-telegram` (bot token still valid? check `.env`) |
| Slack | `/add-slack` (rotate Socket Mode token) |
| Discord | `/add-discord` (bot token in `.env`) |
| Gmail | `/add-gmail` (re-run OAuth) |

```bash
# Did a channel ask for auth recently?
grep -E "QR|pair|authentication required|auth.*failed" logs/nanoclaw.log | tail
```

## Service management

```bash
# Discover your slug
SLUG=$(launchctl list | awk '/com\.nanoclaw-v2-/{print $3}' | sed 's/com\.nanoclaw-v2-//')   # macOS
SLUG=$(systemctl --user list-units --plain --no-legend 'nanoclaw-v2-*' | awk '{print $1}' | sed 's/^nanoclaw-v2-//;s/\.service$//')  # Linux

# macOS — restart
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-v2-$SLUG"

# Linux — restart
systemctl --user restart "nanoclaw-v2-$SLUG.service"

# Live logs (both platforms)
tail -f logs/nanoclaw.log

# Rebuild and restart after host code changes
npm run build && launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-v2-$SLUG"   # macOS
npm run build && systemctl --user restart "nanoclaw-v2-$SLUG.service"          # Linux

# Rebuild the agent container image
./container/build.sh
```

`logs/nanoclaw.log` and `logs/nanoclaw.error.log` are pinned by the
service template in [`setup/service.ts`](../setup/service.ts).

## Where to look for deep dives

- [agent-runner-details.md](agent-runner-details.md) — poll loop, provider interface, MCP tools, retry surface
- [db.md](db.md) — three-DB overview and the single-writer rule
- [db-central.md](db-central.md) — `data/v2.db` schema (`agent_groups`, `messaging_groups`, `sessions`, …)
- [db-session.md](db-session.md) — per-session `inbound.db` / `outbound.db` schema
- [isolation-model.md](isolation-model.md) — `session_mode` semantics and channel-to-agent wiring
- [SECURITY.md](SECURITY.md) — mount security, credential isolation (OneCLI), trust boundaries
- [setup-flow.md](setup-flow.md) — install steps, three output levels, log paths
