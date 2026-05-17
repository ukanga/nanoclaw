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
as a discrete commit (or small commit series) on a `local-v2` integration
branch built from `upstream/channels` / `upstream/main`.

> **Update 2026-05-17 (execution-prep):** Most v1 channels and skills already
> exist on the `upstream/channels` mega-branch — including a full
> `src/channels/signal.ts` (983 lines), `signal.test.ts` (961 lines), and a
> `.claude/skills/add-signal/` skill. Similarly `.claude/skills/claw/` exists.
> §2.1 and §2.5 below have been revised accordingly. **The Signal "port"
> shrinks from "implement from scratch" to "replay the local hardening
> commits on top of `upstream/channels`."** Re-check the rest of §2 before
> starting work on each item; expect more such discoveries.

> **Update 2026-05-17 (no-PR scope):** This is a personal-fork integration,
> not an upstream contribution effort. References to "PRs," "PR sequence,"
> and "target branch" in earlier revisions of this document mean integration
> commits onto a local `local-v2` branch — not pull requests against
> `qwibitai/nanoclaw`. The numbered work items below are still independent
> and ordered; just read "branch → integration step."

---

## 1. v2 surfaces our customizations land on

| Local concept (v1)                             | v2 destination                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/db.ts` (single file)                      | `src/db/` (modules + numbered migrations in `src/db/migrations/`)                                                                                |
| `src/index.ts` orchestrator monolith           | `src/index.ts` + `src/modules/*` (agent-to-agent, approvals, permissions, scheduling, self-mod, typing, interactive, mount-security)             |
| `src/channels/*` in trunk                      | `src/channels/` + each channel ships from its own fork branch (`add-<channel>` skill); registry self-registration via `src/channels/registry.ts` |
| `src/router.ts` (parse + dispatch)             | `src/router.ts` + `src/modules/agent-to-agent/` for destination routing                                                                          |
| `src/task-scheduler.ts`                        | `src/modules/scheduling/` (`db.ts`, `actions.ts`, `recurrence.ts`)                                                                               |
| `src/ipc.ts`                                   | `src/ipc.ts` (still exists, but tasks now go through modules)                                                                                    |
| Per-group `agent-runner-src/` overlays         | One shared read-only `container/agent-runner/` mount; per-group customization via composed `CLAUDE.md`                                           |
| `container/agent-runner/src/index.ts` monolith | `container/agent-runner/src/` split: `poll-loop.ts`, `mcp-tools/*`, `providers/claude.ts`, `db/*`, `formatter.ts`, `destinations.ts`             |
| `container/agent-runner/src/ipc-mcp-stdio.ts`  | `container/agent-runner/src/mcp-tools/core.ts` (+ siblings per module)                                                                           |
| Container runtime: Node                        | **Bun** (entrypoint, package install, runtime)                                                                                                   |
| Per-group `container.json`                     | `container_configs` DB table (managed via `ncl groups config …`)                                                                                 |
| Single shared session DB                       | Two-DB split: `inbound.db` (host writes, container reads) + `outbound.db` (container writes, host reads), per session                            |
| Channel-level admin (`isMain`)                 | User-level roles (`owner` / `admin`) via `messaging_group_agents` wiring                                                                         |
| `.env` credentials → container env             | OneCLI Agent Vault only (mandatory); credentials injected at request time                                                                        |
| `nanoclaw.service` (fixed name)                | Per-install slugged: `nanoclaw-<sha1(projectRoot)[:8]>.service`                                                                                  |

These mappings drive every per-feature port below.

---

## 2. Local feature inventory

### 2.1 Signal channel — **Small/Medium** (revised — was Large)

- **Discovered state:** `upstream/channels` already ships `src/channels/signal.ts` (983 lines), `signal.test.ts` (961 lines), and `.claude/skills/add-signal/` (SKILL.md, REMOVE.md, VERIFY.md). It implements the v2 `ChannelAdapter` contract, self-registers via `registerChannelAdapter('signal', …)` against `./channel-registry.js`, and is functionally on par with local _before_ the Signal-hardening series. Live behaviours already present upstream: quote/reply context (correct `replyTo.sender`/`text` shape), `parseSignalStyles` + `textStyle` param name + `${start}:${length}:${style}` string format, typing indicators via `updateConfiguration` on connect, `EchoCache` text-only dedupe, mention resolution to display names, voice transcription via WHISPER_BIN / OPENAI_API_KEY, image attachments emitted as `[Image: <path>]`, groupV2 + legacy groupInfo, multi-platform send, message chunking.
- **Local deltas to contribute upstream** (per `git log upstream/channels..local -- src/channels/signal.ts`):

  | Local commit                                                     | Behaviour                                                     | Status upstream                                                                                                                     |
  | ---------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
  | `d338917`                                                        | Prevent duplicate Signal messages caused by timeout retry     | Missing — upstream `sendText` has no retry layer                                                                                    |
  | `0d874c2`                                                        | Retry transient send failures before giving up                | Missing                                                                                                                             |
  | `43f8cfc`                                                        | Propagate send failures instead of logging false success      | Missing — upstream `sendText` catches + logs, returns success                                                                       |
  | `a0fc96c`                                                        | Never retry our own AbortController timeout                   | Missing (presupposes the retry layer above)                                                                                         |
  | `5776b7f`                                                        | Include attachments in send dedupe key                        | Missing — upstream `EchoCache` keys on `(platformId, text)` only                                                                    |
  | `84e4fbb`                                                        | Extend retries for attachment sends                           | Missing                                                                                                                             |
  | `7c7a3e7`                                                        | Floor retry delay on stale-connection errors                  | Missing                                                                                                                             |
  | `43349e9`                                                        | Include `attachmentCount` in 'Signal message sent' log        | Missing (trivial)                                                                                                                   |
  | `ba02abd`                                                        | Enable typing indicators on connect via `updateConfiguration` | ✅ Present (line 861-868) — drop, no port                                                                                           |
  | `6519fd7`                                                        | Use correct `textStyle` string format                         | ✅ Present (line 718) — drop                                                                                                        |
  | `bc10c2e`                                                        | Use correct `textStyles` parameter name                       | ✅ Present (line 717-719, param name is `textStyle` — verify singular vs plural matches signal-cli expectations on current version) |
  | `1bc02f2` + `e5769a1`                                            | `parseSignalStyles` + tests                                   | ✅ `parseSignalStyles` present; tests need to merge                                                                                 |
  | `53b2799` + `313b963`                                            | Quote/reply context + tests                                   | ✅ Present (line 690-700 + comment)                                                                                                 |
  | `034ac72`                                                        | Original Signal channel                                       | ✅ Present (in v2 form)                                                                                                             |
  | `62c6f36`                                                        | Avoid double extension when signal-cli id has one             | Belongs to §2.2 (attachment inbound naming)                                                                                         |
  | `1d8a536`                                                        | Drop 0-byte attachments from failed signal-cli downloads      | Belongs to §2.2                                                                                                                     |
  | `0513c83`, `f82252d`, `f2c1e6a`, `51c46b6`, `ada48be`, `6279306` | Attachment materialization + markers + tests                  | §2.2                                                                                                                                |
  | `6979cf8`, `01f3879`                                             | Prettier drift                                                | Drop                                                                                                                                |

- **v2 integration target (the actual scope):**
  - **Step 1a — Signal send retry + dedupe** (landed on `local-v2`, commits `c75e279..762864d`, 6 commits on top of `upstream/channels`, +427/−26): introduces a send-retry layer in `sendText` (and `sendAttachments`); uses a single dedupe key that incorporates the attachment fingerprint; propagates failures up to `deliver` so v2's `src/delivery.ts` can record them in `dropped_messages`; exempts our own `Signal RPC timeout:` errors from retry; floors retry delay on stale-connection errors; extends retry budget for attachment sends. Consolidates `d338917` + `0d874c2` + `43f8cfc` + `a0fc96c` + `5776b7f` + `84e4fbb` + `7c7a3e7`.
  - **Step 1b — drop.** Local commit `43349e9` was an `attachmentCount`-on-`Signal message sent` log enrichment; in v2 the text and attachment sends produce separate log lines that already carry the count. No port needed.
- **DB migration:** none.
- **Dependencies:** none — these are in-file behaviour fixes on the existing v2 adapter. §2.2 (attachments) is the larger work and follows separately.
- **Drop:** any standalone "implement Signal from scratch" effort; SKILL.md rewrite (upstream's covers it).
- **Test surface:** read upstream `signal.test.ts` and add cases for the behaviours added in step 1a. Don't wholesale-port the 1889-line local file; it contains attachment-flow tests (§2.2) and tests for behaviours upstream already covers.
- **Verify-before-PR:** confirm that signal-cli's current `--tcp` JSON-RPC param is `textStyle` (singular, as upstream has it). Local commit `bc10c2e` flipped names; the live behaviour at signal-cli HEAD matters more than what either branch says.

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
- **Recon 2026-05-17 — v2 already has most of the plumbing:**
  - `src/session-manager.ts:extractAttachmentFiles` materializes base64 `content.attachments[].data` to `<sessionDir>/inbox/<messageId>/<filename>` and replaces `data` with `localPath`. Called from `writeSessionMessage`.
  - `src/session-manager.ts:readOutboxFiles` reads outbox files into `OutboundFile[]` for delivery — already wired in `src/delivery.ts:355`.
  - `src/attachment-naming.ts` and `src/attachment-safety.ts` exist with generic helpers (`isSafeAttachmentName`).
  - `OutboundFile[]` is in the v2 `ChannelAdapter.deliver` signature. The Signal step-1a work already calls `sendAttachments(platformId, files)`.
  - `container/agent-runner/src/formatter.ts:formatAttachments` (≈ line 223) renders `content.attachments[]` to `[type: name — saved to localPath]` in the agent's XML prompt.
  - **Highest existing migration is 013** (`approval-render-metadata.ts`). Slots 014 and 015 are free. No DB migration is needed for attachment metadata — `content` is a JSON blob and accepts arbitrary nested `attachments`.
- **v2 integration target (per-unit, cross-references `docs/attachment-port-plan.md`):**
  - **Unit 3 (step #2) — Inbound materialization for Signal.** ✅ Landed on `local-v2` (`ea33dc9..788ec24`, 2026-05-17). `handleEnvelope` now builds `content.attachments[]` with `{ name, type, mimeType, size, data: <base64> }` for every entry in `dataMessage.attachments`; the host's `extractAttachmentFiles` does the file write. Signal-specific helpers (`findCachedAttachment`, `signalCachePlaceholderExists`, `sanitizeAttachmentName`, `MAX_ATTACHMENT_BYTES`, `CONTENT_TYPE_EXT`) live at the top of `src/channels/signal.ts`. The `[Image: <cache-path>]` inline path injection is gone — `formatAttachments` renders from `content.attachments[]`. A second guard skips `onInbound` when an envelope carried _only_ attachments and every one was rejected (oversize / 0-byte placeholder / missing cache).
  - **Unit 8 (step #3) — Outbound attachments.** ✅ Superseded by v2's `send_file` MCP tool (`container/agent-runner/src/mcp-tools/core.ts:134-178`, instructions at `mcp-tools/core.instructions.md:17-19`). The agent calls `mcp__nanoclaw__send_file({ path, text?, filename?, to? })` instead of emitting `[[attach:…]]` markers. The tool resolves the path (absolute or relative to `/workspace/agent/`), copies the file into `/workspace/outbox/<id>/<filename>`, and writes `{ text, files: [filename] }` into `messages_out.content`. The container `/workspace` mount points at the same dir the host's `readOutboxFiles` reads (`src/container-runner.ts:256`), so the host wiring (`src/delivery.ts:350`) consumes it as-is and passes `OutboundFile[]` to Signal's `deliver` (which now calls `sendAttachments` per step 1a). Outcome: zero marker-parser code to port. The architectural reversal `docs/attachment-port-plan.md` predicted ("marker parsing moves from host to container") landed as "marker parsing replaced by an explicit tool call" — cleaner, no parsing at all.
  - **Unit 10 (step #4) — TTL cleanup.** ✅ Landed on `local-v2` (`517c9af`, 2026-05-17). New module `src/attachment-sweep.ts` walks every `<sessionsBaseDir>/<agentGroupId>/<sessionId>/{inbox,outbox}/<messageId>/` and prunes files past `ATTACHMENT_RETENTION_DAYS` (default 30, env-overridable). Empty `messageId` subdirs are removed in the same pass; the parent `inbox/`/`outbox/` dirs are left alone (`initSessionFolder` owns them). 60s startup delay then a tick every hour — matches v1 cadence. Wired into `src/index.ts` alongside `startHostSweep`. No DB migration. Filesystem walk (not `getActiveSessions`) so abandoned session dirs still get cleaned. 18 new test cases in `src/attachment-sweep.test.ts`.
- **DB migration:** **NO.** v2's content blob already carries attachments. (Was wrong in the earlier draft.)
- **Dependencies:** step 1a (Signal hardening) is in. v2's destinations/formatter/extractAttachmentFiles/readOutboxFiles already merged.
- **Test surface:** add to `src/channels/signal.test.ts` for unit 3 cases (per-file: oversize reject, 0-byte placeholder reject, missing cache, unsafe filename, image+pdf+oversize mix, voice + transcription). New tests for the agent-runner marker parser in unit 8. Reuse host's existing extractAttachmentFiles tests as-is.

### 2.3 Session features — **Medium**

- **`src/session-rotation.ts` (146)** + test — auto-rotate group sessions at byte threshold. ✅ Landed on `local-v2` (`2ea0795`, 2026-05-17) as **`container/agent-runner/src/session-rotation.ts`** + tests. **Earlier draft of this row was wrong on two counts:** (1) the v1 size check reads the SDK's `.jsonl` transcript (post-`compact_boundary` live bytes), _not_ NanoClaw's IPC databases — there's nothing to read from `inbound.db`/`outbound.db` for this. (2) The "where to land it" guess (`src/modules/scheduling/` or `src/db/`) was wrong — the host has no handle on the SDK conversation or transcript, so rotation lives in the container agent-runner where the SDK runs. Implementation: after each user-driven `result` event in `poll-loop.processQuery`, if live transcript bytes ≥ `AUTO_COMPACT_THRESHOLD_BYTES` (default 500_000, env-overridable), push `/compact` into the open SDK stream and set `rotationInFlight` to swallow the resulting `compact_boundary` event (so the user doesn't see "Context compacted…" they didn't trigger). The v1 CONTINUATION_PROMPT step (write summary to CLAUDE.md before compact) is **dropped** — v2's `PreCompact` hook in `container/agent-runner/src/providers/claude.ts` already archives the full transcript to `/workspace/agent/conversations/<date>-<slug>.md`, which is strictly stronger persistence than v1's 200-word bullet summary.
- **`src/session-files.ts` (42)** + test — helpers for size-on-disk. ✅ Superseded — its `liveSessionBytes` and `getAutoCompactThresholdBytes` helpers were inlined into the new container module above. `sessionFilePath(folder, sessionId)` is replaced by `transcriptPath(continuation, cwd)` which derives the SDK project key from cwd (`/workspace/agent` → `-workspace-agent`) at the in-container path `/home/node/.claude/projects/<key>/<continuation>.jsonl`. The projects-dir is env-overridable via `CLAUDE_PROJECTS_DIR` so the helper is testable outside the container.
- **`src/session-commands.ts` (179)** + test — `ADMIN_SENDERS`-gated session admin commands. ✅ Pre-landed upstream via `src/command-gate.ts` (no port work). **Earlier draft of this row was wrong on its framing:** v1's module gated exactly _one_ command (`/compact`) — not a multi-command admin surface as the previous wording ("e.g. `/rotate`, `/clear-session`, `/sessions`") implied; those commands never existed in v1. v2's `src/command-gate.ts` gates a strict superset (`/clear`, `/compact`, `/context`, `/cost`, `/files`) against the v2 `user_roles` model (owner / global-admin / scoped-admin via `src/modules/permissions/db/user-roles.ts`), and is wired at `src/router.ts:413` — _after_ the access gate at line 265 already filtered non-members. So the denial UX ("Permission denied: …") only reaches senders who passed the access gate, which is functionally equivalent to v1's "only notify if sender would normally be allowed to interact" check, just achieved through layering instead of an inline predicate. v1's pre-compact message batching (run agent on pending messages, _then_ run `/compact`) is unnecessary in v2 for the same reason step 5 drops the v1 CONTINUATION_PROMPT step — v2 has a long-lived SDK stream that already processes inbound messages as they arrive. `ADMIN_SENDERS` env var is gone from v2 (zero references in `src/`, `container/`, `scripts/`). The `ncl sessions` overlap noted in the previous draft is not realized — there is no `ncl` binary in `upstream/channels`; references in this plan are forward-looking, not present-day reality.
- **`src/index.ts` integration:** force-close container on idle when over rotation threshold; "session getting heavy" warning to main group. **Both dropped.** Force-close-on-idle is unnecessary because v2's poll-loop pushes `/compact` directly into the live SDK stream (the v1 dance only existed because v1 ran one SDK process per agent invocation, so the post-reply hook had to fire _between_ invocations). The "session getting heavy" warning is dropped because v2 has no global "main group" concept (multiple agent groups, per-user roles) and the new flow is fully silent — there is no user-visible side effect to warn about.
- **DB migration:** none.
- **Drop:** `ADMIN_SENDERS` env var (use v2 user roles).

### 2.4 Delivery failures replay — **Small**

- **Files:** `src/delivery-failures.ts` (52) + test, `src/router.ts` (warning when output is discarded after marker parsing), `scripts/repro-silent-drop.ts`
- **What it does:** if a `send_message` fails, replay the failure into the agent on its next turn so it can retry / change tack instead of silently dropping the response.
- **v2 port target:** v2 has `src/delivery.ts` and `src/db/dropped-messages.ts` (migration `008-dropped-messages.ts`). The local "replay on next turn" likely already exists in v2 in some form via `dropped_messages` + `messages_in.on_wake`. **Verify before porting**: read `src/delivery.ts` and the `008-dropped-messages.ts` migration; if the v2 mechanism covers our case, we just delete the local module. If not, port the replay path on top of `dropped_messages`.
- **DB migration:** none from us if we adopt the v2 `dropped_messages` table.

### 2.5 `claw` CLI — **Small** (revised — was Medium)

- **Discovered state:** `.claude/skills/claw/` exists on `upstream/channels` with `SKILL.md` and `scripts/claw` (374 lines). Local has `scripts/claw` (479 lines, ~105 lines ahead) — same Python CLI, almost certainly older + smaller upstream.
- **What it does:** standalone CLI to run a container agent without a chat channel, using OneCLI credential proxy.
- **v2 integration target:** diff `upstream/channels:.claude/skills/claw/scripts/claw` against `local:scripts/claw`; replay the local-only deltas as a commit on `local-v2`. Drop the from-scratch port plan.
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

## 4. Suggested integration order

Each row is an independent branch off `upstream/main`, mergeable on its own. Order maximises parallel work and unblocks dependents early.

Integration order onto `local-v2` (built off `upstream/channels` — which already carries the Signal channel, `add-signal`, and `claw` skills). Order maximises parallelism and unblocks dependents early.

| #   | Integration step                          | Scope                                                                                                                                                                                                            | Size | Status                                |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------- |
| 1a  | Signal send retry + dedupe                | 2.1 retry layer + propagate failures + attachment-aware dedupe + own-timeout exempt + stale-conn floor + attachment retry budget                                                                                 | S/M  | ✅ landed `c75e279..762864d`          |
| 2   | Signal inbound attachment materialization | 2.2 unit 3 — adapter builds `content.attachments[]` with base64; host's existing `extractAttachmentFiles` does the file write. No DB migration.                                                                  | M    | ✅ landed `ea33dc9..788ec24`          |
| 3   | Outbound attachments                      | 2.2 unit 8 — superseded by v2's `send_file` MCP tool: it writes `<sessionDir>/outbox/<messageId>/<filename>` + `content.files` directly, no marker parser needed. Host `readOutboxFiles` already wires the rest. | M    | ✅ pre-landed upstream (no port work) |
| 4   | Attachment TTL sweep                      | 2.2 unit 10 — new sweeper for `<sessionDir>/inbox/` + outbox dirs at `ATTACHMENT_RETENTION_DAYS`.                                                                                                                | S    | ✅ landed `517c9af`                   |
| 5   | Session rotation                          | 2.3 rotation + size helpers — landed container-side as proactive `/compact` against the SDK transcript                                                                                                           | M    | ✅ landed `2ea0795`                   |
| 6   | Session commands                          | 2.3 admin gate for `/compact` — pre-landed via `src/command-gate.ts` (gates `/clear`, `/compact`, `/context`, `/cost`, `/files` on `user_roles`)                                                                 | M    | ✅ pre-landed upstream (no port work) |
| 7   | Delivery replay                           | 2.4 — **only if** v2 `dropped_messages` doesn't already cover it                                                                                                                                                 | S    |
| 8   | Vendor container skills                   | 2.7 copy 10 container skills + sanity pass                                                                                                                                                                       | S    |
| 9   | `claw` deltas                             | 2.5 diff `local:scripts/claw` against `upstream/channels:.claude/skills/claw/scripts/claw`, replay the ~105-line delta                                                                                           | S    |
| 10  | Helper scripts                            | 2.6 rewrite scripts on `ncl`                                                                                                                                                                                     | S    |
| 11  | Agent-runner reliability                  | 2.8 surviving items                                                                                                                                                                                              | S    |
| 12  | Docs debug checklist                      | 2.9 doc deltas                                                                                                                                                                                                   | S    |

Estimated total effort: ~0 L + ~2 M + ~6 S ≈ 1–1.5 focused weeks (was 3–4 before the `upstream/channels` discovery; further trimmed 2026-05-17 when step 3 turned out to be pre-landed via `send_file`, then again when step 4 landed; trimmed again when step 5 landed as a smaller container-side change than the plan predicted; trimmed once more when step 6 turned out to be pre-landed via `src/command-gate.ts`).

**Integration branch:**

- `local-v2` (off `upstream/channels`) — currently at step 5's tip (`2ea0795`). Checked out in worktree `/tmp/nanoclaw-signal-pr/`. Live install on `local` continues running v1; switch over once `local-v2` reaches feature parity. Steps 3 and 6 needed no code commits (pre-landed upstream via `send_file` and `command-gate.ts` respectively); steps 2, 4, and 5 landed as code commits on `local-v2`. Next active integration step is #7 (delivery replay), gated on the §2.4 verify-before-port check.

---

## 5. Verify-before-porting checklist

Before writing code for each numbered step above, confirm the v2 surface.

> **General rule from the 2026-05-17 discovery:** before scoping any branch
> below, also `git ls-tree -r upstream/channels` for whatever the local file is.
> Many v1 channels and skills already live there in v2 form.

- [x] **2.1 Signal** — DONE 2026-05-17. v2 adapter lives at `upstream/channels:src/channels/signal.ts` (registered via `channel-registry.ts`, not `registry.ts`). Skill at `upstream/channels:.claude/skills/add-signal/`. Local deltas mapped in §2.1.
- [x] **2.2 Attachments** — DONE 2026-05-17. Inbound landed (`ea33dc9..788ec24`). Outbound is **pre-landed upstream** via `send_file` (`container/agent-runner/src/mcp-tools/core.ts:134-178`) — no marker code to slot. TTL sweep landed (`517c9af`, `src/attachment-sweep.ts`).
- [x] **2.3 Session rotation** — DONE 2026-05-17. Discovery: the size check is on the SDK's `.jsonl` transcript (post-`compact_boundary` live bytes), not NanoClaw's IPC DBs. Landed container-side at `container/agent-runner/src/session-rotation.ts` (`2ea0795`); see §2.3 for the architecture rationale and §4 row #5 for the SHA. v1's CONTINUATION_PROMPT step dropped in favor of v2's existing `PreCompact` transcript archive.
- [x] **2.3 Session commands** — DONE 2026-05-17. Discovery: v1's `session-commands.ts` gated exactly one command (`/compact`) — not the multi-command surface earlier drafts implied. v2's `src/command-gate.ts` gates a superset (`/clear`, `/compact`, `/context`, `/cost`, `/files`) on `user_roles` and is already wired in `src/router.ts`. `ADMIN_SENDERS` env var is gone. No port work — see §2.3 third bullet and §4 row #6.
- [ ] **2.4 Delivery replay** — read `src/delivery.ts` and `src/db/migrations/008-dropped-messages.ts`. If `dropped_messages.on_wake` already replays into the agent's next turn, **drop the local module**.
- [x] **2.5 `claw`** — DONE 2026-05-17. Skill exists at `upstream/channels:.claude/skills/claw/`. Diff approach in §2.5.
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
Backup tag: `pre-update-082091e-20260517-092019`

`git reset --hard pre-update-082091e-20260517-092019` returns this checkout to
the pre-update state.
