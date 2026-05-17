---
name: claw
description: Install the claw CLI tool — talk to your NanoClaw agent from the command line without opening a chat app.
---

# claw — NanoClaw CLI

`claw` is a Python CLI that talks to your running NanoClaw v2 service over
its local Unix socket (`data/cli.sock`). It writes a JSON line per
prompt, reads JSON replies back, and prints them to stdout.

## What it does

- Send a prompt to whichever agent is wired to `cli/local`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all messaging groups and their wired agents with `--list-groups`
- Verbose mode (`-v`) shows resolved paths and the JSON sent over the wire

## Prerequisites

- Python 3.8 or later
- NanoClaw v2 installed and the service running
  (`launchctl`/`systemd` — `data/cli.sock` must exist)
- An agent wired to `cli/local`. The CLI channel ships with main and
  registers on service start; wire an agent to it via `/init-cli-agent`
  or `/manage-channels`

No container runtime is required: claw no longer spawns containers; it
just speaks the CLI channel protocol to the host service, which owns
the agent containers.

## Install

Run this skill from within the NanoClaw directory. The script auto-detects its location, so the symlink always points to the right place.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/claw" scripts/claw
chmod +x scripts/claw
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/claw" ~/bin/claw
```

Make sure `~/bin` is in `PATH`. Add this to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload the shell:

```bash
source ~/.zshrc   # or ~/.bashrc
```

### 3. Verify

```bash
claw --list-groups
```

You should see the messaging groups registered on this install and
which agent group (if any) is wired to each.

## Usage Examples

```bash
# Default: send a prompt to whatever is wired to cli/local
claw "What's on my calendar today?"

# Read prompt from stdin
echo "Summarize this" | claw --pipe

# Pipe a file with a prefix prompt
cat report.txt | claw --pipe "Summarize this report"

# List messaging groups and their wired agents
claw --list-groups

# Verbose mode (debug info)
claw -v "Hello"

# Custom timeout for long-running tasks (default 300s for first reply)
claw --timeout 600 "Run the full analysis"
```

## Notes

- **Single-client chat semantics.** The CLI channel allows one
  concurrent terminal chat. Running `claw` while
  `pnpm run chat` is open in another terminal evicts that chat client
  (it will print `[superseded by a newer client]` and disconnect).
  Two `claw` invocations from different terminals exhibit the same
  eviction behaviour. This is by design — see the header of
  `src/channels/cli.ts`.
- **Socket permissions.** `data/cli.sock` is `chmod 0600`. claw must
  run as the same uid as the NanoClaw service.
- **v1 flags removed.** `-g/--group`, `-j/--jid`, `-s/--session`,
  `--runtime`, and `--image` no longer apply in v2. Multi-group
  routing goes through the channel's own chat app (or by wiring more
  agents to `cli/local`); sessions are auto-managed by the host
  (`src/host-sweep.ts`).

## Troubleshooting

### "NanoClaw CLI socket not found"

The service isn't running, or it's running in a different install
directory. Start the service (`launchctl kickstart -k
gui/$(id -u)/com.nanoclaw-v2-<slug>` on macOS, `systemctl --user
restart nanoclaw-v2-<slug>` on Linux). If you have multiple installs,
set `NANOCLAW_DIR` to point at the one you want to talk to.

### "timeout: no reply in 300s"

No agent is wired to `cli/local`, or the wired agent's container is
stuck. Run `claw --list-groups` to confirm a row with channel `cli`
and platform id `local` has an agent. Tail `logs/nanoclaw.log` for
container/poll-loop errors; see `docs/DEBUG_CHECKLIST.md`.

### "[superseded by a newer client]"

Another terminal (probably `pnpm run chat`) connected after you did.
Reconnect — your previous prompt's reply may already be in
`data/v2-sessions/<agent>/<session>/outbound.db` even though it never
reached this terminal.

### Override the NanoClaw directory

If `claw` can't find your install (you have multiple checkouts, or
you're running from outside the repo), set `NANOCLAW_DIR`:

```bash
export NANOCLAW_DIR=/path/to/your/nanoclaw
```
