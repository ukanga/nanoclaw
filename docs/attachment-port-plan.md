# Attachment-system port to upstream Signal architecture

## Why this exists

The `local` branch carries a Signal attachment system (9 commits across DB, channel, router, agent-runner, scheduler) that pre-dates upstream's own Signal channel. Upstream's Signal adapter has parity for rich text and quote/reply, but **no attachment support**. A blind cherry-pick won't work because the surrounding architecture has shifted (channel registry, session DB split, container-owned outbox). This document maps each piece of the attachment work to its new home.

Audit basis: see `git cherry main local` and the per-commit deep-dive in conversation history. The 9 commits in scope:

```
f367241 feat: store attachment metadata on messages
0513c83 feat: materialize Signal attachments into group inbox
f82252d feat: append attachment markers to inbound message text
f2c1e6a test: cover inbound Signal attachment handling
51c46b6 feat: send Signal attachments via sendMessage
6dda28b feat: parse [[attach:...]] markers from agent output
ada48be test: cover outbound attachment send path
d6e045b feat: TTL cleanup for attachment inbox/outbox
62c6f36 fix: avoid double extension when signal-cli id has one
bcd2270 fix: parse [[attach:]] in streaming agent output too
1d8a536 fix(signal): drop 0-byte attachments from failed signal-cli downloads
```

Also see `docs/BRANCH-FORK-MAINTENANCE.md` for upstream's general guidance on fork maintenance.

## Architectural overview

| Concern                   | `local` (your fork)                                                            | `main` (upstream)                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Channel definition        | Class instance exported from `src/channels/signal.ts`, wired in `src/index.ts` | Skill-installed adapter at `setup/channels/signal.ts`, registered via `registerChannelAdapter(name, factory)`        |
| Channel lookup            | Direct reference                                                               | `src/channels/channel-registry.ts`, looked up by `channelType`                                                       |
| Outbound delivery         | Channel does its own send                                                      | Host reads files from session outbox, calls `adapter.deliver(platformId, threadId, message, files?: OutboundFile[])` |
| Session DB                | Single `messages` table with attachments column                                | Split: `messages_in` (host-owned) and `messages_out` (container-owned)                                               |
| Attachment storage        | Group-rooted: `groups/<folder>/inbox/`, `groups/<folder>/outbox/`              | Session-rooted: `/workspace/outbox/<messageId>/<filename>`                                                           |
| Marker parsing            | Host-side in `src/router.ts`                                                   | Must move container-side into agent-runner, since the agent-runner is what writes outbox files                       |
| Existing helpers upstream | —                                                                              | `src/attachment-naming.ts`, `src/attachment-safety.ts`, `src/session-manager.ts:readOutboxFiles()`                   |

The single biggest delta: **`[[attach:…]]` marker parsing moves from the host router to the container agent-runner.** Reason: only the container can write into the session outbox before the host reads it. This inverts where the work happens but simplifies the host.

## Unit-by-unit port plan

### 1. Inbound attachment metadata in `messages_in`

- **What:** Carry attachment metadata (filename, contentType, size, host path) alongside inbound messages so downstream tooling can find them.
- **Local:** `src/db.ts` — ALTER TABLE adding `attachments` TEXT column; serialization in `storeMessage`/`getNewMessages`.
- **Upstream destination:** Likely no schema change needed. Upstream's `InboundMessage.content` is already a JSON blob; nest `attachments: AttachmentMeta[]` inside it. Confirm in `src/db/session-db.ts` (or whichever file owns messages_in).
- **Delta:** Schema-free if `content` accepts arbitrary fields; otherwise add a column.
- **Risk:** Low.
- **Depends on:** none.

### 2. Inbound naming + safety helpers (Signal-specific)

- **What:** Filename sanitization, MIME→extension fallback, double-extension avoidance, 0-byte placeholder detection (the `62c6f36` and `1d8a536` fixes).
- **Local:** `src/channels/signal.ts` (sanitizeAttachmentName, findCachedAttachment, signalCachePlaceholderExists).
- **Upstream destination:** Reuse `src/attachment-naming.ts` and `src/attachment-safety.ts` for generic logic. Keep Signal-specific bits (signal-cli cache placeholder detection, id-already-has-extension check) inside the Signal adapter at `setup/channels/signal.ts`.
- **Delta:** Code organization only. Adopt upstream's helpers; don't duplicate.
- **Risk:** Low.
- **Depends on:** none.

### 3. Inbound: materialize Signal attachments

- **What:** When signal-cli reports `dataMessage.attachments[]`, copy the cached files out of `~/.local/share/signal-cli/attachments/` into a session-owned location, building `AttachmentMeta` for each.
- **Local:** `src/channels/signal.ts:59–150` (materializeAttachments).
- **Upstream destination:** `setup/channels/signal.ts` (Signal adapter's inbound handler). Destination directory is `/workspace/outbox/<messageId>/<filename>` rather than `groups/<folder>/inbox/`.
- **Delta:** Path root and ownership change. **Open question:** the adapter's inbound callback may not yet know the session/messageId — see Open questions §1.
- **Risk:** Med — session-id resolution at inbound time.
- **Depends on:** Unit 2.

### 4. Inbound: append attachment markers to message text

- **What:** Append `[Attachment: <path>, <contentType>, <size>]` lines to the inbound message body, so the agent sees them as readable text.
- **Local:** `src/channels/signal.ts:150–165` (after materialize, before invoking onMessage).
- **Upstream destination:** Same adapter file, same flow position. Marker paths now refer to outbox-rooted paths.
- **Delta:** Path strings only.
- **Risk:** Low.
- **Depends on:** Unit 3.

### 5. Inbound tests

- **What:** Single/multi-file, oversize rejection, malicious filename, missing cache file, attachment-only message, attachment + quote.
- **Local:** `src/channels/signal.test.ts` (six test functions).
- **Upstream destination:** New `setup/channels/signal.test.ts` (or wherever upstream's adapter test lives). Tests use tmpdirs for the signal-cli cache and session outbox.
- **Delta:** Mechanical: adjust paths, env vars, and the adapter object shape.
- **Risk:** Low.
- **Depends on:** Units 3–4.

### 6. Outbound: Signal `deliver()` accepts files

- **What:** Pass attached files to signal-cli's JSON-RPC `send.params.attachments`.
- **Local:** `src/channels/signal.ts:165–200` — extends `sendMessage(jid, text, attachments?: string[])`.
- **Upstream destination:** `setup/channels/signal.ts` — extend the adapter's `deliver(platformId, threadId, message, files?: OutboundFile[])`. Files arrive as `{ filename, data: Buffer }` already loaded by the host; adapter writes them to a temp path and passes the path to signal-cli (signal-cli wants paths, not buffers — check current upstream behaviour).
- **Delta:** Adapter no longer reads files from disk itself. No path validation needed (host did it). Chunking is handled by `delivery.ts`, not the adapter — but **see Open questions §3** about attaching files only to the first chunk.
- **Risk:** Low–Med.
- **Depends on:** none.

### 7. Outbound test

- **What:** Cover the send path with mocked signal-cli RPC.
- **Local:** `ada48be` test commit on `src/channels/signal.test.ts`.
- **Upstream destination:** Sibling test file. Mock the adapter's RPC client.
- **Risk:** Low.
- **Depends on:** Unit 6.

### 8. Container: outbound attachments via `send_file` (was: parse `[[attach:…]]`)

- **Status:** ✅ Pre-landed upstream — no port work. v2 ships `send_file` as
  an MCP tool (`container/agent-runner/src/mcp-tools/core.ts:134-178`), which
  replaces the entire marker-parser approach with an explicit tool call.
- **What v2 does instead:** the agent calls
  `mcp__nanoclaw__send_file({ path, text?, filename?, to? })`. The handler:
  1. Resolves `path` (absolute, or relative to `/workspace/agent/`).
  2. Rejects missing files via `fs.existsSync`.
  3. `fs.copyFileSync` into `/workspace/outbox/<id>/<filename>`.
  4. Writes a `messages_out` row with
     `content: { text, files: [filename] }`.
     The host's `readOutboxFiles` (`src/session-manager.ts:365`) picks the
     files up — already wired in `src/delivery.ts:350`. No streaming-marker
     edge case to handle, because each `send_file` call is its own outbound
     message that flushes mid-turn.
- **Local commits this supersedes:**
  - `6dda28b feat: parse [[attach:...]] markers from agent output`
  - `ada48be test: cover outbound attachment send path`
  - `bcd2270 fix: parse [[attach:]] in streaming agent output too`
- **What still needs a one-time touch (outside this port):** any
  `groups/*/CLAUDE.md` rules that mention `[[attach:…]]` should be rewritten
  to instruct the agent to call `send_file`. That's a content edit per
  install, not a code change.

### 9. Host: read outbox files into `OutboundFile[]`

- **What:** Host-side code that, given a messages_out row with filenames, reads files from `/workspace/outbox/<messageId>/` and packages them as `OutboundFile[]` for the adapter.
- **Local:** Bundled with channel send.
- **Upstream destination:** **Already implemented upstream** at `src/session-manager.ts:readOutboxFiles()`, with `isSafeAttachmentName` guards. Just wire the agent-runner → DB bridge so this code has filenames to read.
- **Delta:** None — reuse upstream as-is.
- **Risk:** Low.
- **Depends on:** Unit 8 (writes filenames).

### 10. TTL cleanup

- **Status:** ✅ Landed on `local-v2` (`517c9af`, 2026-05-17).
- **What:** Periodic cleanup of attachment storage (default 30 days, env-overridable via `ATTACHMENT_RETENTION_DAYS`, hourly walk, 60s startup delay).
- **Local:** `src/task-scheduler.ts` — runAttachmentCleanup, startAttachmentCleanupLoop. Walks `groups/*/inbox` and `groups/*/outbox`.
- **v2 landing:** New module `src/attachment-sweep.ts`. Walks every `<sessionsBaseDir>/<agentGroupId>/<sessionId>/{inbox,outbox}/<messageId>/` (filesystem walk, not `getActiveSessions` — that way abandoned session dirs still get cleaned). Prunes files older than the cutoff, then removes any `messageId` subdir left empty. Parent `inbox/`/`outbox/` dirs are left in place — `initSessionFolder` owns them.
- **Delta from v1:** Path roots moved from group-rooted (`groups/<folder>/{inbox,outbox}/`) to session-rooted with an extra `<messageId>/` level. Algorithm otherwise identical to v1's `runAttachmentCleanup`.
- **Wiring:** `startAttachmentSweep()` called from `src/index.ts` next to `startHostSweep`; `stopAttachmentSweep()` from the shutdown path.
- **Risk:** Med (resolved during landing — no concurrent-writer issues since `clearOutbox` only deletes per-message dirs synchronously during delivery, and TTL only touches files older than 30 days).
- **Depends on:** Units 3 and 8 (so there's something to clean up). Both landed.
- **Test coverage:** 18 cases in `src/attachment-sweep.test.ts` — pure helpers, per-session walker (inbox + outbox + missing subdir + mixed mtimes + empty-dir cleanup), top-level orchestrator, and the start/stop loop with fake timers.

## Suggested implementation order

> **2026-05-17 update:** All units 1–10 are landed or pre-landed upstream
> (see status notes per-unit). Attachment port is complete on `local-v2`
> as of `517c9af`. Original order kept below for history.

1. **Unit 2** — Naming/safety helpers. ✅ Pre-landed upstream
   (`src/attachment-safety.ts:isSafeAttachmentName`).
2. **Unit 1** — Confirm whether `messages_in.content` accepts nested attachments. ✅ Yes, it's a JSON blob (no migration).
3. **Unit 3** — Inbound materialization. ✅ Landed `ea33dc9..788ec24` on `local-v2`.
4. **Unit 4** — Marker append. ✅ Replaced by `formatter.ts:formatAttachments` rendering from `content.attachments[]`.
5. **Unit 5** — Inbound tests. ✅ 7 cases landed in `788ec24`.
6. **Unit 6** — Adapter `deliver()` files parameter. ✅ v2 ships it; Signal `sendAttachments` wired in step 1a.
7. **Unit 8** — Outbound. ✅ Pre-landed upstream via `send_file` MCP tool. No marker parser needed.
8. **Unit 9** — Host `readOutboxFiles`. ✅ Already wired (`src/delivery.ts:350`).
9. **Unit 7** — Outbound tests. ✅ Covered by Signal `deliver` tests with `files: [...]`.
10. **Unit 10** — TTL cleanup. ✅ Landed `517c9af` on `local-v2` (`src/attachment-sweep.ts` + 18 tests).

## Open questions (resolve before implementing each marked unit)

> **Resolution summary 2026-05-17.** v2's `send_file` MCP tool moots Q2–Q4
> by replacing the entire marker grammar with an explicit tool call. Q1 was
> resolved by Unit 3's landed implementation. Q5 was resolved by the same
> commit's `content.attachments[]` shape.

1. **Session-id at inbound time (Unit 3).** ✅ Resolved. The Signal adapter
   emits `content.attachments[]` with `{ name, type, mimeType, size, data:
<base64> }`; the host's `extractAttachmentFiles` (in `src/session-manager.ts`)
   does the file write once `messageId` exists downstream. Adapter never
   touches the session dir. See `src/channels/signal.ts:handleEnvelope`
   (post-`c22f170`).

2. **Marker-to-DB protocol (Unit 8).** ✅ Resolved by `send_file`. The
   container writes `messages_out.content.files: string[]` directly via the
   MCP tool handler (`container/agent-runner/src/mcp-tools/core.ts:166-173`);
   no `outbound_files` column, no convention scan, no in-text marker. The
   filename list is the source of truth.

3. **Chunking interaction (Units 6, 8).** ✅ Resolved by `send_file`'s
   message-per-file model. Each `send_file` call produces one
   `messages_out` row, so chunking is irrelevant — text and files travel as
   separate messages from the agent's perspective. Inside Signal's
   `deliver`, the per-call shape is "send text first (chunked if needed),
   then files" (`src/channels/signal.ts:1238-1242`), so within one row the
   file is always attached after the text — never split across chunks.

4. **Marker path root (Unit 8).** ✅ Moot. No marker exists in v2. The
   agent passes a file path to `send_file({ path, ... })`; the tool
   resolves it (absolute or relative to `/workspace/agent/`) and copies
   into `/workspace/outbox/<id>/<filename>`. Existing agent prompts that
   referenced `[[attach:…]]` need updating to call `send_file` instead, but
   that's a per-prompt change, not a parser config.

5. **`AttachmentMeta` shape.** ✅ Resolved. Inbound:
   `content.attachments[]` carries `{ name, type, mimeType, size, data:
<base64>, localPath? }` — `data` is set by the adapter; `localPath` is
   set by the host after `extractAttachmentFiles` runs. Outbound:
   `content.files: string[]` listing filenames inside
   `<sessionDir>/outbox/<messageId>/`.

## Verification

- Inbound: send a Signal message with one image, one PDF, and one oversized file. Confirm metadata reaches the agent, oversized file is rejected with a logged warning, agent can `Read` the inbox path.
- Outbound: prompt the agent to attach a generated file. Confirm the file lands in `/workspace/outbox/<messageId>/`, the host's `delivery.ts` reads it via `readOutboxFiles`, the adapter delivers it via signal-cli, and the marker doesn't appear in the user-visible text.
- Streaming: prompt the agent to attach a file mid-stream. Confirm the marker is parsed in the streaming chunk, not just the final output.
- Cleanup: set `ATTACHMENT_RETENTION_DAYS=0`, wait for the loop, confirm files older than 0 days are gone.
- Migration: drop a fresh checkout of `local` (post-port) on top of `main`, run the install, send messages with attachments end-to-end without manual intervention.
