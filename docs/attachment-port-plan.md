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

| Concern | `local` (your fork) | `main` (upstream) |
|---|---|---|
| Channel definition | Class instance exported from `src/channels/signal.ts`, wired in `src/index.ts` | Skill-installed adapter at `setup/channels/signal.ts`, registered via `registerChannelAdapter(name, factory)` |
| Channel lookup | Direct reference | `src/channels/channel-registry.ts`, looked up by `channelType` |
| Outbound delivery | Channel does its own send | Host reads files from session outbox, calls `adapter.deliver(platformId, threadId, message, files?: OutboundFile[])` |
| Session DB | Single `messages` table with attachments column | Split: `messages_in` (host-owned) and `messages_out` (container-owned) |
| Attachment storage | Group-rooted: `groups/<folder>/inbox/`, `groups/<folder>/outbox/` | Session-rooted: `/workspace/outbox/<messageId>/<filename>` |
| Marker parsing | Host-side in `src/router.ts` | Must move container-side into agent-runner, since the agent-runner is what writes outbox files |
| Existing helpers upstream | — | `src/attachment-naming.ts`, `src/attachment-safety.ts`, `src/session-manager.ts:readOutboxFiles()` |

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

### 8. Container: parse `[[attach:…]]` in agent output (the big one)

- **What:** When the agent emits `[[attach:/workspace/group/<rel>]]` in its output, the agent-runner must:
  1. Recognize the marker (in both buffered and streaming output).
  2. Resolve the path, reject traversals.
  3. Write the file (or symlink/copy) to `/workspace/outbox/<messageId>/<filename>`.
  4. Strip the marker from the text the user sees.
  5. Persist filenames to `messages_out` so the host can pick them up.
- **Local:**
  - `src/router.ts:40–70` — `parseAttachmentMarkers(text, groupFolder, groupsBaseDir)`.
  - `src/index.ts:240–270` — `extractAttachments` closure, wired at three sites (streaming, scheduler, IPC).
  - `bcd2270` — hoist extractAttachments to module scope so streaming can reuse it.
- **Upstream destination:**
  - New `container/agent-runner/src/output-parser.ts` (or extend existing parsing module) for `parseAttachmentMarkers`.
  - Modify `container/agent-runner/src/index.ts` (the streaming/output loop) to call it on each chunk and on final output.
  - On match: copy file into `/workspace/outbox/<messageId>/`, then write filenames into the messages_out row.
- **Delta:** Architectural reversal. Host router does no parsing; container agent-runner becomes the producer of outbox files. Marker semantics change: the path inside `[[attach:…]]` may need to remain group-rooted (so existing agent prompts work), but the agent-runner is responsible for translating to the outbox path.
- **Risk:** **High.** This is the load-bearing piece and where the most rework is.
- **Depends on:** Units 1, 6, plus Open questions §2 and §4.

### 9. Host: read outbox files into `OutboundFile[]`

- **What:** Host-side code that, given a messages_out row with filenames, reads files from `/workspace/outbox/<messageId>/` and packages them as `OutboundFile[]` for the adapter.
- **Local:** Bundled with channel send.
- **Upstream destination:** **Already implemented upstream** at `src/session-manager.ts:readOutboxFiles()`, with `isSafeAttachmentName` guards. Just wire the agent-runner → DB bridge so this code has filenames to read.
- **Delta:** None — reuse upstream as-is.
- **Risk:** Low.
- **Depends on:** Unit 8 (writes filenames).

### 10. TTL cleanup

- **What:** Periodic cleanup of attachment storage (default 30 days, env-overridable, hourly walk, 60s startup delay to avoid contention).
- **Local:** `src/task-scheduler.ts` — runAttachmentCleanup, startAttachmentCleanupLoop. Walks `groups/*/inbox` and `groups/*/outbox`.
- **Upstream destination:** New `src/attachment-cleanup.ts` (or fold into `src/session-manager.ts`). Walk session outbox roots instead of group roots.
- **Delta:** Path roots change; algorithm identical.
- **Risk:** Med.
- **Depends on:** Units 3 and 8 (so there's something to clean up).

## Suggested implementation order

1. **Unit 2** — Naming/safety helpers. Self-contained; small; unblocks 3.
2. **Unit 1** — Confirm whether `messages_in.content` accepts nested attachments, schema-change if not.
3. **Unit 3** — Inbound materialization (resolve Open question §1 first).
4. **Unit 4** — Marker append.
5. **Unit 5** — Inbound tests (lock down units 3–4 before touching outbound).
6. **Unit 6** — Adapter `deliver()` files parameter. Independent of the inbound flow.
7. **Unit 8** — Container marker parsing + outbox writes. **Highest risk; do first feature-complete pass on a side branch before merging.**
8. **Unit 9** — Wire host's existing `readOutboxFiles` to the new agent-runner output.
9. **Unit 7** — Outbound tests.
10. **Unit 10** — TTL cleanup last; non-critical for correctness.

## Open questions (resolve before implementing each marked unit)

1. **Session-id at inbound time (Unit 3).** The Signal adapter receives an inbound event but session resolution (messaging-group → agent → wiring) happens downstream in the router. Options:
   - (a) Lazy materialization: adapter emits metadata pointing at the signal-cli cache path, router copies files post-resolution.
   - (b) Eager materialization to a per-channel staging dir, then move into `/workspace/outbox/<messageId>/` once the messageId exists.
   - (c) Change adapter contract so the inbound callback returns a Promise that gets the messageId injected.
   What's the upstream intent? Pick one and stick with it.

2. **Marker-to-DB protocol (Unit 8).** When the agent-runner finishes a turn, how does it tell the host which files belong to the outbound message? Options:
   - New `outbound_files` column on `messages_out` (JSON array of filenames).
   - Convention: any file present in `/workspace/outbox/<messageId>/` is part of the message.
   - Marker-in-text: leave `[[attach:…]]` markers in the row's text and have `delivery.ts` parse them.
   The first option is most explicit; pick before writing code.

3. **Chunking interaction (Units 6, 8).** Local code attaches files only to the first chunk of a split message. Upstream's `delivery.ts` may handle chunking. If it does: which chunk gets the files? (First, last, all, none-and-send-separately.) Inspect `delivery.ts` and decide.

4. **Marker path root (Unit 8).** Should the agent see `/workspace/group/outbox/...` (matches your existing prompts and skill instructions) or `/workspace/outbox/<messageId>/...` (matches upstream's session structure)? If the former, the agent-runner translates; if the latter, every existing agent prompt needs updating. Recommendation: keep group-rooted in the marker, translate in agent-runner.

5. **`AttachmentMeta` shape.** What fields does upstream's content blob expect, if any? If the answer is "nothing yet, you're defining it," lock the schema in this doc before writing the first inbound port.

## Verification

- Inbound: send a Signal message with one image, one PDF, and one oversized file. Confirm metadata reaches the agent, oversized file is rejected with a logged warning, agent can `Read` the inbox path.
- Outbound: prompt the agent to attach a generated file. Confirm the file lands in `/workspace/outbox/<messageId>/`, the host's `delivery.ts` reads it via `readOutboxFiles`, the adapter delivers it via signal-cli, and the marker doesn't appear in the user-visible text.
- Streaming: prompt the agent to attach a file mid-stream. Confirm the marker is parsed in the streaming chunk, not just the final output.
- Cleanup: set `ATTACHMENT_RETENTION_DAYS=0`, wait for the loop, confirm files older than 0 days are gone.
- Migration: drop a fresh checkout of `local` (post-port) on top of `main`, run the install, send messages with attachments end-to-end without manual intervention.
