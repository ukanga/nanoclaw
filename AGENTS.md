# NanoClaw Agent Instructions

This repository is built to be modified by coding agents. Claude Code is the original management surface, but Codex should be able to operate it by following this file and the referenced skill files.

## Project Shape

- `src/` contains the host process: routing, DB access, channel registries, container spawning, provider container configuration.
- `container/agent-runner/src/` contains the in-container runner: polling `messages_in`, invoking the selected provider, exposing NanoClaw MCP tools, and writing `messages_out`.
- `container/skills/` contains runtime skills mounted into every agent container.
- `.claude/skills/` contains repo-management skills such as setup, channel/provider installation, debugging, updates, and customization. Codex does not list these as native slash commands, so read the matching `SKILL.md` directly when the user asks for one.
- `groups/<folder>/container.json` controls per-agent runtime behavior, including `provider`, `skills`, mounts, packages, MCP servers, and assistant identity.

## Codex Skill Use

Codex CLI does not currently expose Claude Code project skills as native commands. Treat a request like `/debug`, `/customize`, `/add-codex`, `/manage-channels`, or `/update-nanoclaw` as:

1. Open `.claude/skills/<name>/SKILL.md` if it exists.
2. Follow that file as the workflow for the turn.
3. If the skill references sibling files, resolve them relative to the skill directory.
4. If the skill asks Claude-specific questions, adapt the intent to Codex while preserving the same safety checks and git workflow.

For runtime container skills such as `/status` and `/capabilities`, the agent runner has a provider fallback: providers without native slash-command support load `container/skills/<name>/SKILL.md` and inject it into the turn.

## Provider Notes

- Claude remains the native/default provider.
- Codex support is installed in `src/providers/codex.ts` and `container/agent-runner/src/providers/codex.ts`.
- Codex auth is supplied from host `~/.codex/auth.json` or `OPENAI_API_KEY`; the host provider copies auth into a per-session `/home/node/.codex`.
- To switch a group at runtime, set `"provider": "codex"` in `groups/<folder>/container.json`. Keep DB provider columns in sync when setup docs or scripts require host-side provider contributions.

## Common Commands

- Typecheck: `pnpm run typecheck`
- Unit tests: `pnpm test`
- Agent-runner Codex tests: `cd container/agent-runner && bun test src/providers/codex.factory.test.ts src/skill-commands.test.ts`
- Build host: `pnpm run build`

## Editing Rules

- Preserve user changes in a dirty worktree.
- Prefer existing patterns over new abstractions.
- Keep provider-specific behavior behind provider modules or narrow runner adapters.
- Do not add broad runtime dependencies for a small management feature.
- For new channel or provider capabilities, prefer a skill workflow over baking feature code directly into trunk.
