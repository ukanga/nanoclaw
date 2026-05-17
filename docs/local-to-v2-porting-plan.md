# Local → v2 Porting Plan

Scoping document for reimplementing the 80 `local`-branch commits on top of
`upstream/main` (currently v2.0.63). Generated 2026-05-17.

- **Merge base:** `3ab833b` (2026-03-28)
- **`local` HEAD:** `082091e` (80 commits ahead, 1058 behind)
- **`upstream/main` HEAD:** `2ab6926` (v2.0.63)
- **Cumulative local diff vs base:** 67 files, +8334 / −74
- **Backup tag:** `pre-update-082091e-20260517-092019`

A direct merge is impractical because v2.0.0 is an architectural rewrite. This
plan organises the local work into independent feature ports so each can land
as its own PR on a fresh branch off `upstream/main`.

---

## 1. v2 surfaces our customizations land on

| Local concept (v1) | v2 destination |
|---|---|
| `src/db.ts` (single file) | `src/db/` (modules + numbered migrations in `src/db/migrations/`) |
| `src/index.ts` orchestrator monolith | `src/index.ts` + `src/modules/*` (agent-to-agent, approvals, permissions, scheduling, self-mod, typing, interactive, mount-security) |
| `src/channels/*` in trunk | `src/channels/` + each channel ships from its own fork branch (`add-<channel>` skill); registry self-registration via `src/channels/registry.ts` |
| `src/router.ts` (parse + dispatch) | `src/router.ts` + `src/modules/agent-to-agent/` for destination routing |
| `src/task-scheduler.ts` | `src/modules/scheduling/` (`db.ts`, `actions.ts`, `recurrence.ts`) |
| `src/ipc.ts` | `src/ipc.ts` (still exists, but tasks now go through modules) |
| Per-group `agent-runner-src/` overlays | One shared read-only `container/agent-runner/` mount; per-group customization via composed `CLAUDE.md` |
| `container/agent-runner/src/index.ts` monolith | `container/agent-runner/src/` split: `poll-loop.ts`, `mcp-tools/*`, `providers/claude.ts`, `db/*`, `formatter.ts`, `destinations.ts` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `container/agent-runner/src/mcp-tools/core.ts` (+ siblings per module) |
| Container runtime: Node | **Bun** (entrypoint, package install, runtime) |
| Per-group `container.json` | `container_configs` DB table (managed via `ncl groups config …`) |
| Single shared session DB | Two-DB split: `inbound.db` (host writes, container reads) + `outbound.db` (container writes, host reads), per session |
| Channel-level admin (`isMain`) | User-level roles (`owner` / `admin`) via `messaging_group_agents` wiring |
| `.env` credentials → container env | OneCLI Agent Vault only (mandatory); credentials injected at request time |
| `nanoclaw.service` (fixed name) | Per-install slugged: `nanoclaw-<sha1(projectRoot)[:8]>.service` |

These mappings drive every per-feature port below.

---

## 2. Local feature inventory

### 2.1 Signal channel — **Large**

- **Files:** `src/channels/signal.ts` (1199 lines), `src/channels/signal.test.ts` (1889 lines), `src/channels/index.ts` (+3), `docs/signal-setup.md`, `.env.example` (+SIGNAL_*)
- **What it does:** signal-cli JSON-RPC client. Inbound polling + outbound `sendMessage`. Inbound quote/reply context. Native text formatting (`textStyles`). Typing indicators via `updateConfiguration`. Robust retry/dedupe: AbortController-timeout exemption, attachment-aware dedupe keys, attachment retries, stale-connection retry-delay floor, transient send retries before giving up. 0-byte attachment drop. Double-extension fix when signal-cli id already has one.
- **v2 port target:** new branch `skill/add-signal` on the channels-fork model. Implement `channelImpl` against the v2 channel adapter interface (`src/channels/adapter.ts`) and self-register through `src/channels/registry.ts`. Move docs to the skill's `SKILL.md`. Credentials (`SIGNAL_NUMBER`, signal-cli URL) move into the skill's OneCLI registration.
- **DB migration:** none from us; channel registration uses the v2 migration `012-channel-registration.ts`.
- **Dependencies:** must port first — attachments, group-activity script, several `src/index.ts` integration points all assume Signal exists.
- **Drop:** any in-tree edits to `src/channels/index.ts` (v2 uses registry self-registration).
- **Test surface:** rewrite the 1889-line test against the v2 adapter contract; keep the regression cases (quote context, textStyles param name & string format, attachment dedupe, AbortController timeout exemption, double-extension, 0-byte drop).

### 2.2 Attachments end-to-end — **Large**

- **Existing porting notes:** `docs/attachment-port-plan.md` (already on local; reuse as a starting point).
- **Files:** `src/index.ts` (storage / wiring), `src/router.ts` (parse `[[attach:…]]` markers), `container/agent-runner/src/index.ts` (+111, marker emission), `container/agent-runner/src/ipc-mcp-stdio.ts` (+2/-2, tool description), `groups/global/CLAUDE.md` (+rules), `groups/main/CLAUDE.md` (+rules), `.claude/skills/customize/SKILL.md`, `.claude/skills/debug/SKILL.md`
- **What it does:**
  1. Inbound: materialize Signal attachments into per-group inbox under a deterministic name (`avoid double extension when signal-cli id has one`).
  2. Store attachment metadata on the message row.
  3. Append `[[attach:…]]` markers to inbound text so the agent sees them.
  4. Outbound: agent emits `[[attach:…]]` markers (including in streaming output); router parses, validates, and bundles into `signal.sendMessage` `attachments` parameter.
  5. Multi-bubble behaviour: one `send_message` per file = one bubble (documented).
  6. TTL cleanup for both inbox and outbox.
- **v2 port target:**
  - Inbound materialization: stays in the Signal skill (where the channel knows the attachment id).
  - Marker emission/parsing: `container/agent-runner/src/formatter.ts` + `destinations.ts` already do destination markers in v2; add attachment-marker parsing alongside. Tool descriptions live in `mcp-tools/core.instructions.md`.
  - Metadata: probably a new column on `messages_in` / `messages_out` (the v2 names) or a sidecar table. Needs a numbered migration in `src/db/migrations/` (next free slot ≥ `016-`).
  - TTL cleanup: separate host-side sweeper module (analogous to `src/host-sweep.ts` which v2 already ships).
  - Group rules: rewrite for the v2 composed-`CLAUDE.md` model.
- **DB migration:** **YES** — `016-attachment-metadata.ts` (or split into per-direction). Schema TBD; minimum is `attachment_count INT DEFAULT 0`, ideally a `message_attachments(message_id, path, mime, bytes)` table indexed by `message_id`.
- **Dependencies:** Signal channel ported first. v2 destinations/formatter already merged.
- **Test surface:** keep the inbound + outbound + TTL test files; rewrite to use the v2 two-DB session split.

### 2.3 Session features — **Medium**

Three new modules. All assume single-shared-session DB on v1; v2 has split inbound/outbound DBs per session.

- **`src/session-rotation.ts` (146)** + test — auto-rotate group sessions at byte threshold. **v2 port:** likely belongs in `src/modules/scheduling/` or alongside `src/db/session-db.ts`. Trigger point moves from idle-marker to agent-reply (already merged). Rotation threshold check has to read both `inbound.db` and `outbound.db` sizes.
- **`src/session-files.ts` (42)** + test — helpers for size-on-disk. **v2 port:** trivial adapter against `src/db/sessions.ts` paths.
- **`src/session-commands.ts` (179)** + test — `ADMIN_SENDERS`-gated session admin commands. **v2 port:** the gate moves from env-based `ADMIN_SENDERS` to the v2 user-roles model (`src/modules/permissions/`). Commands themselves wrap `ncl sessions` operations and may overlap with the v2 `ncl` CLI — prefer extending `ncl` rather than reintroducing a parallel command surface.
- **`src/index.ts` integration:** force-close container on idle when over rotation threshold; "session getting heavy" warning to main group. Both need rewriting against the v2 orchestrator + new permissions model (which group is "main" is no longer a global concept).
- **DB migration:** none required directly; but rotation-on-reply needs the v2 `messages_out` write event as the trigger.
- **Drop:** `ADMIN_SENDERS` env var (use v2 user roles).

### 2.4 Delivery failures replay — **Small**

- **Files:** `src/delivery-failures.ts` (52) + test, `src/router.ts` (warning when output is discarded after marker parsing), `scripts/repro-silent-drop.ts`
- **What it does:** if a `send_message` fails, replay the failure into the agent on its next turn so it can retry / change tack instead of silently dropping the response.
- **v2 port target:** v2 has `src/delivery.ts` and `src/db/dropped-messages.ts` (migration `008-dropped-messages.ts`). The local "replay on next turn" likely already exists in v2 in some form via `dropped_messages` + `messages_in.on_wake`. **Verify before porting**: read `src/delivery.ts` and the `008-dropped-messages.ts` migration; if the v2 mechanism covers our case, we just delete the local module. If not, port the replay path on top of `dropped_messages`.
- **DB migration:** none from us if we adopt the v2 `dropped_messages` table.

### 2.5 `claw` CLI — **Medium**

- **Files:** `scripts/claw` (479 lines)
- **What it does:** standalone CLI to run a container agent without a chat channel, using OneCLI credential proxy.
- **v2 port target:** v2 ships its own `ncl` admin CLI (`src/cli/`, container-side `container/agent-runner/src/cli/ncl.ts`) and a `/claw` operational skill. **Verify** the v2 `/claw` skill (if it exists) — if it covers the same workflow, delete ours. If `/claw` is host-side and `ncl` is admin/DB, they coexist; port `claw` as a thin wrapper over `ncl groups …`.
- **DB migration:** none.

### 2.6 Helper scripts — **Small**

- `scripts/group-activity.sh` (111) — per-group snapshot
- `scripts/group-context-size.sh` (100) — live (post-compact) bytes vs on-disk size
- `scripts/reset-group-session.sh` (32)
- **v2 port:** rewrite to read from the two-DB session split (`inbound.db` + `outbound.db`) and from `container_configs`. Reuse `ncl sessions get` / `ncl groups config get` where possible — these scripts probably collapse to small wrappers around `ncl`.
- **DB migration:** none.

### 2.7 Vendored container skills — **Small (port = copy)**

- `container/skills/diagnose/`, `grill-with-docs/`, `improve-codebase-architecture/`, `prototype/`, `tdd/`, `triage/`, `to-issues/`, `to-prd/`, `zoom-out/`, `setup-matt-pocock-skills/` — 10 SKILL.md files + ~25 supporting docs, ~805 lines total
- **v2 port target:** these are container-side skills loaded inside the agent container. v2 still has `container/skills/`. **Port = `git checkout local -- container/skills/<name>`** for each, then a sanity pass for v2 references (e.g. `nanoclaw.service` → install-slug).
- **DB migration:** none.

### 2.8 Agent-runner reliability — **Small (cherry-pick equivalents)**

Already on local from earlier cherry-picks; reapply on v2:
- `eac85ae` SDK auto-retry on `Unable to connect to API` — v2 equivalent likely already exists; check `container/agent-runner/src/providers/claude.ts` and `circuit-breaker.ts`.
- `09508f8` agent-runner exits on `_close` not just SIGKILL — check v2 `poll-loop.ts` shutdown path; reapply if missing.
- `ee56f40` prune stale files from per-group `agent-runner-src` on every spawn — **drop**: v2 removed per-group overlays, no longer applicable.
- `1dbabea` full-tree staleness walk for cached agent-runner — **drop**: same reason as above.
- **DB migration:** none.

### 2.9 Other small touches — **Small**

- `ec173e3` rename assistant Andy → Nini — sweep for "Andy" on v2 (likely zero or one hit; rename in your install's user/agent-group config rather than in trunk code).
- `b2bfe92`-era prettier drift commits — drop, will reformat post-port.
- `.env.example` cleanup (removing core NanoClaw vars; pino removed) — v2 has its own `.env.example`; re-evaluate after porting credentials to OneCLI.
- `docs/DEBUG_CHECKLIST.md` additions (UND_ERR_SOCKET recovery, signal attachment download gap) — append to v2 `docs/DEBUG_CHECKLIST.md` as a separate doc commit.

---

## 3. DB migrations required

Only one local feature needs a new schema migration: **attachments (2.2)**.

Numbered next slot ≥ `016-` (current max upstream is `015-cli-scope.ts`):

- **`016-attachment-metadata.ts`** — adds attachment columns / table referenced by `messages_in` and `messages_out`. Exact shape TBD during 2.2 implementation. Provide an up-migration only; v2 migrations don't ship downs.

Verify before writing: read `src/db/migrations/012-channel-registration.ts` and `015-cli-scope.ts` for the v2 migration helper style.

All other features (Signal, sessions, delivery, scripts, container skills, agent-runner reliability) require **no new migrations**, only adoption of v2's existing tables.

---

## 4. Suggested PR sequence

Each row is an independent branch off `upstream/main`, mergeable on its own. Order maximises parallel work and unblocks dependents early.

| # | Branch | Scope | Size |
|---|---|---|---|
| 1 | `skill/add-signal` | 2.1 Signal channel as a v2 channel skill | L |
| 2 | `feat/attachment-metadata` | 2.2 migration `016-` + storage plumbing only (no markers yet) | M |
| 3 | `feat/attachment-markers` | 2.2 marker emission + parsing + bundling in send | M |
| 4 | `feat/attachment-ttl-sweep` | 2.2 inbox/outbox TTL sweeper | S |
| 5 | `feat/session-rotation` | 2.3 rotation + size helpers, adapted to two-DB split | M |
| 6 | `feat/session-commands` | 2.3 admin commands behind v2 user-roles | M |
| 7 | `feat/delivery-replay` | 2.4 — **only if** v2 `dropped_messages` doesn't already cover it | S |
| 8 | `chore/vendor-container-skills` | 2.7 copy 10 container skills + sanity pass | S |
| 9 | `feat/claw-cli` | 2.5 — **only if** v2 `/claw` skill doesn't cover it | M |
| 10 | `chore/helper-scripts` | 2.6 rewrite scripts on `ncl` | S |
| 11 | `fix/agent-runner-reliability` | 2.8 surviving items | S |
| 12 | `chore/docs-debug-checklist` | 2.9 doc deltas | S |

Estimated total effort: ~3 L + ~5 M + ~5 S ≈ 3–4 focused weeks.

---

## 5. Verify-before-porting checklist

Before writing code for each numbered branch above, confirm the v2 surface:

- [ ] **2.1 Signal** — read `src/channels/adapter.ts`, `src/channels/registry.ts`, and one in-tree channel skill (e.g. `skill/add-telegram`) to learn the adapter contract.
- [ ] **2.2 Attachments** — read v2 `messages_in` / `messages_out` schema in `container/agent-runner/src/db/messages-in.ts` and `messages-out.ts`. Read `formatter.ts` + `destinations.ts` to see where to slot the marker code.
- [ ] **2.3 Session rotation** — read `src/db/session-db.ts`, `src/db/sessions.ts`, and `src/session-manager.ts` to learn how sessions are sized in v2.
- [ ] **2.4 Delivery replay** — read `src/delivery.ts` and `src/db/migrations/008-dropped-messages.ts`. If `dropped_messages.on_wake` already replays into the agent's next turn, **drop the local module**.
- [ ] **2.5 `claw`** — `ls .claude/skills/claw/` on upstream/main. If it exists, read its SKILL.md before deciding whether to port the local script.
- [ ] **2.8 Reliability** — read `container/agent-runner/src/providers/claude.ts` and `circuit-breaker.ts` for the v2 retry surface.

---

## 6. Things to drop outright

These local commits should **not** be carried forward:

- Per-group agent-runner cache pruning / staleness fixes (`ee56f40`, `1dbabea`) — v2 eliminated the per-group overlay model.
- `merge: catch up with upstream main` and the ~15 `Merge branch 'main' into skill/compact` merge commits — pure plumbing, no semantic content.
- All `chore: prettier formatting drift` commits — reformat post-port in one shot.
- `ADMIN_SENDERS` env var (used in 2.3) — replace with v2 user roles.
- `.env.example` core-var cleanup — v2 `.env.example` is different; re-curate during OneCLI migration.
- `chore: rename assistant from Andy to Nini` — apply via v2 agent-group config, not as a trunk edit.

---

## 7. Pre-port one-time steps

Before starting branch #1, on a fresh checkout of `upstream/main`:

1. Run `bash migrate-v2.sh` (or `/migrate-from-v1` from inside Claude Code) to bring your install's DB, sessions, scheduled tasks, and group folders forward to the v2 layout. This is the "necessary db migration" the request mentioned — none of the per-feature work above will compose with your existing groups/sessions until this is done.
2. Run `/init-onecli` if not already on OneCLI (current install already is per `MEMORY.md`, so this is a no-op).
3. Re-apply channel skills your install used (`/add-signal` after branch #1 lands; meanwhile keep using the `local` branch for production).
4. Confirm the service name change: your launchd/systemd unit becomes `nanoclaw-<slug>.service`. Update any scripts (the helper scripts in 2.6, the rotation cron in 2.3) before they start firing.

---

## 8. Rollback

Backup branch: `backup/pre-update-082091e-20260517-092019`
Backup tag:    `pre-update-082091e-20260517-092019`

`git reset --hard pre-update-082091e-20260517-092019` returns this checkout to
the pre-update state.
