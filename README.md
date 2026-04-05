# jira-acp

> AI-powered Jira pipeline CLI: Ticket → Code → GitHub → Deploy → Notify

[![npm version](https://img.shields.io/npm/v/jira-acp.svg)](https://www.npmjs.com/package/jira-acp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`jiraACP` automates the full ticket lifecycle for small dev teams. Pick up a Jira ticket in the morning — by the time you check Telegram, it's been analyzed, coded, reviewed, and deployed. Ambiguous tickets send a clarification message instead of silently failing.

---

## Installation

```bash
npm install -g jira-acp
```

**Requirements:** Node.js >= 20, [Claude Code](https://claude.ai/code) installed globally.

---

## Quick Start

```bash
# 1. Configure a project (interactive wizard)
jiraACP init

# 2. Start the background server
jiraACP start

# 3. Run the pipeline for a ticket
jiraACP run PROJ-123
```

---

## Two Binaries

| Binary | Purpose |
|--------|---------|
| `jiraACP` | Pipeline CLI — all commands |
| `jiraACP-mcp` | Jira MCP server — auto-configured for Claude Code agents |

`jiraACP init` writes `.mcp.json` into your workspace so Claude Code agents have Jira tools available automatically.

---

## How It Works

Each **project** binds one Jira instance + one GitHub repo + one Claude Code workspace + one Telegram chat into a single orchestrated unit.

### 9-Stage Pipeline

| Stage | What happens | Model |
|-------|-------------|-------|
| 1. Fetch | Pull assigned Jira tickets | Haiku |
| 2. Analyze | Clarity scoring — criteria, design, dependencies | Haiku→Sonnet |
| 3. Clarify | Telegram prompt if ambiguous, await human reply | Haiku |
| 4. Code | Claude Code implements the ticket in your workspace | Sonnet/Opus |
| 5. Git | Create branch, commit, push, open PR | Haiku |
| 6. Review | Two-agent PR review, auto-merge if clean | Sonnet×2 |
| 7. Deploy | Run your deploy script | Haiku |
| 8. Test | Playwright agent tests on dev server | Sonnet |
| 9. Notify | Jira: transition + comment. Telegram: done | Haiku |

Stage 4 auto-upgrades to Opus for auth, payments, DB schema changes, or cross-module refactoring.

---

## CLI Reference

### Server (Daemon)

```bash
jiraACP start [--port 3100]   # Start background server
jiraACP stop                   # Stop background server
jiraACP restart                # Restart background server
jiraACP status                 # Check if server is running
jiraACP logs [-f] [-n 100]     # Tail server logs
```

### Setup

```bash
jiraACP init [--dir <path>]            # Interactive setup wizard
jiraACP doctor [--fix]                 # Health-check all integrations
jiraACP update-context                 # Regenerate CLAUDE.md from codebase scan
jiraACP projects list|add|remove       # Manage configured projects
```

### Pipeline

```bash
jiraACP run <ticketKey> [options]
  --project <name>    Target project (default: auto-detect from git)
  --from <stage>      Start from this stage
  --to <stage>        End at this stage
  --dry-run           Simulate without side effects
  --no-confirm        Non-interactive mode

jiraACP sprint [--project] [--sprint] [--parallel 2] [--filter <jql>] [--dry-run]
jiraACP triage [--project] [--sprint]
```

### Monitoring

```bash
jiraACP status [ticketKey]             # Daemon status, or pipeline state for a ticket
jiraACP logs [ticketKey] [-f]          # Server logs, or ticket pipeline logs
jiraACP dashboard [--watch]            # Terminal UI of active runs
jiraACP replay <ticketKey>             # Replay completed run event log
jiraACP usage [--month YYYY-MM]        # Token cost report per project
```

### Control

```bash
jiraACP pause <ticketKey>
jiraACP resume <ticketKey>
jiraACP abort <ticketKey> [--reason]
jiraACP cancel-clarification <ticketKey>
```

### Config

```bash
jiraACP config get [<key>]
jiraACP config set <key> <value>
jiraACP config edit
```

### Schedule

```bash
jiraACP schedule add --cron "0 9 * * 1-5" --project <name>
jiraACP schedule list
jiraACP schedule remove <id>
```

### Utilities

```bash
jiraACP serve [--port 3100]    # Foreground webhook server (for dev/Docker)
```

---

## Configuration

Configs live at `~/.jira-acp/`:

```
~/.jira-acp/
├── config.json              # Global shared settings (tokens, pipeline defaults)
└── projects/
    └── my-project.json      # Per-project overrides
```

### Global config (`~/.jira-acp/config.json`)

Shared settings across all projects:

```json
{
  "telegram": { "botToken": "env:TELEGRAM_BOT_TOKEN" },
  "github": { "token": "env:GITHUB_TOKEN" },
  "pipeline": {
    "maxCostUsdPerRun": 2.0,
    "skipClarificationIfClear": true,
    "failOnDeployFailure": true
  }
}
```

### Project config (`~/.jira-acp/projects/<name>.json`)

Project-specific settings (override global):

```json
{
  "name": "my-saas",
  "jira": {
    "url": "https://myteam.atlassian.net",
    "email": "dev@myteam.com",
    "token": "env:JIRA_TOKEN",
    "projectKey": "PROJ",
    "clarityScoreThreshold": 0.7
  },
  "github": {
    "owner": "myorg",
    "repo": "my-saas",
    "defaultBranch": "main",
    "autoMergeStrategy": "squash"
  },
  "workspace": {
    "rootDir": "/path/to/codebase"
  },
  "telegram": {
    "chatId": "-1001234567890"
  }
}
```

Use `"env:VAR_NAME"` for any sensitive value — safe to commit the config file.

---

## Human-in-the-Loop

jiraACP contacts you on Telegram when a decision is needed:

| Trigger | What you get |
|---------|-------------|
| Clarity score below threshold | Questions + `/answer PROJ-123` template |
| PR review: major issues | PR diff + Approve / Reject buttons |
| Merge conflict | Conflicting files + "I'll resolve" button |
| Tests fail after 3 retries | Playwright screenshot + error + Re-run button |
| Cost about to exceed limit | "Continue / Abort?" prompt |

**Clarification timeout flow** (default: 1 hour):
- T+30m — reminder
- T+45m — "Pipeline skips in 15 min"
- T+60m — execute `clarificationTimeoutAction` (`skip` / `abort` / `proceed-with-warning`)

### Telegram Commands

| Command | Action |
|---------|--------|
| `/run <ticketKey>` | Start pipeline for a ticket |
| `/abort <ticketKey>` | Abort running pipeline |
| `/resume <ticketKey>` | Resume paused pipeline |
| `/status` | Active pipeline states |
| `/logs` | Recent server log |
| `/tickets` | Open tickets grouped by release version |
| `/ticket <key>` | Ticket detail |
| `/projects` | Configured projects |
| `/archive <key>` | Close ticket topic |
| `/verbosity low\|medium\|high` | Notification verbosity |

---

## Crash Recovery

Pipelines survive crashes. State is an append-only event log:

```bash
# Process killed mid-way through Stage 4 (Code)
jiraACP resume PROJ-123
# Detects dead lock, offers: "Resume from 'code'? [Y/n]"
# Replays events, restores context, restarts from Stage 4
```

State stored per-ticket at `~/.jira-acp/runs/<project>/<ticketKey>/`.

---

## Security

- **No plaintext secrets** — use `"env:VAR_NAME"` in config. `jiraACP doctor` warns on plaintext tokens.
- **Minimal env forwarding** — agents receive only `PATH`, `HOME`, `ANTHROPIC_API_KEY`, project vars. Never full `process.env`.
- **No shell injection** — all subprocess calls use `spawn(cmd, argsArray)`, never `exec(templateString)`.
- **Agent path scoping** — writes restricted to `workspace.allowedPaths`.
- **Telegram filtering** — only messages from configured `chatId` accepted.
- **Atomic locks** — `O_EXCL` open flag, crash-safe, no zombie pipelines.

---

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | >= 20 | Runtime |
| [Claude Code](https://claude.ai/code) | latest | AI coding agent |
| Jira Cloud | — | Ticket source |
| GitHub | — | PR target |
| Telegram Bot | — | Notifications + human-in-the-loop |

---

## License

MIT
