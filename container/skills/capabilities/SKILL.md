---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

List skill directories mounted into the container:

```bash
ls -1 /app/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. The directory name is the skill name (e.g., `agent-browser` → `/agent-browser`).

### 2. Available tools

Read the allowed tools from your SDK configuration. You always have access to:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** `mcp__nanoclaw__*` (messaging, scheduling, persistent agents, self-modification)

### 3. MCP server tools

The NanoClaw MCP server exposes these tools (via `mcp__nanoclaw__*` prefix):

- **Messaging:** `send_message`, `send_file`, `edit_message`, `add_reaction`
- **Scheduling:** `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`
- **Persistent agents:** `create_agent` (spin up a named agent as a bidirectional destination)
- **Interactive:** `ask_user_question`, `send_card`
- **Self-modification:** `install_packages`, `add_mcp_server` (require admin approval)

### 4. Container skills (Bash tools)

Check for executable tools in the container:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Workspace info

```bash
ls /workspace/agent/CLAUDE.md 2>/dev/null && echo "Agent memory: yes" || echo "Agent memory: no"
ls /workspace/global 2>/dev/null && echo "Global folder: yes (read-only)" || echo "Global folder: no"
```

## Report format

Present the report as a clean, readable message. Example:

```
📋 *NanoClaw Capabilities*

*Installed Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
(list all found skills)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web: WebSearch, WebFetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_message, send_file, schedule_task, create_agent, ask_user_question, …

*Container Tools:*
• agent-browser: ✓

*Workspace:*
• Agent memory: yes/no
• Global folder: yes (read-only) / no
```

Adapt the output based on what you actually find — don't list things that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
