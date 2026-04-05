# jiraACP — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        jira-acp (npm)                           │
│                                                                  │
│  ┌──────────────────────────┐  ┌───────────────────────────┐    │
│  │   jiraACP (CLI)          │  │   jiraACP-mcp             │    │
│  │   pipeline orchestrator  │  │   Jira MCP server         │    │
│  │                          │  │   (for Claude agents)     │    │
│  └──────────┬───────────────┘  └──────────────┬────────────┘    │
│             │                                  │                  │
│             └──────── jira/client.ts ──────────┘                 │
│                       (shared core)                              │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  Pipeline stages               Claude Code agents
  call Jira directly            use via MCP protocol
  (no MCP overhead)
```

---

## Layer Architecture

```
┌─────────────────────────────────────────┐
│  Layer 5: CLI (commander.js)            │  ← User interface
├─────────────────────────────────────────┤
│  Layer 4: Pipeline Orchestrator         │  ← Stage sequencer, state machine
├─────────────────────────────────────────┤
│  Layer 3: Stages (9 units)              │  ← Business logic per stage
├─────────────────────────────────────────┤
│  Layer 2: Integrations                  │  ← Jira, GitHub, Telegram, Claude
├─────────────────────────────────────────┤
│  Layer 1: Infrastructure                │  ← Config, state, lock, logger
└─────────────────────────────────────────┘
```

---

## Directory Structure

```
jira-acp/
├── src/
│   ├── cli.ts                          # bin: jiraACP — commander.js entry
│   ├── mcp.ts                          # bin: jiraACP-mcp — MCP server entry
│   ├── index.ts                        # Public API (programmatic use)
│   │
│   ├── commands/                       # CLI command handlers (thin layer)
│   │   ├── init.ts                     # jiraACP init
│   │   ├── run.ts                      # jiraACP run <ticketKey>
│   │   ├── sprint.ts                   # jiraACP sprint
│   │   ├── triage.ts                   # jiraACP triage
│   │   ├── status.ts                   # jiraACP status
│   │   ├── dashboard.ts                # jiraACP dashboard
│   │   ├── logs.ts                     # jiraACP logs
│   │   ├── doctor.ts                   # jiraACP doctor
│   │   ├── schedule.ts                 # jiraACP schedule
│   │   ├── serve.ts                    # jiraACP serve
│   │   └── config.ts                   # jiraACP config
│   │
│   ├── pipeline/                       # Core pipeline engine
│   │   ├── orchestrator.ts             # Stage sequencer + state machine driver
│   │   ├── runner.ts                   # Claude Code subprocess wrapper
│   │   ├── state.ts                    # Append-only event log + derived state
│   │   └── stages/
│   │       ├── types.ts                # Stage interface + context types
│   │       ├── 1-fetch.ts
│   │       ├── 2-analyze.ts
│   │       ├── 3-clarify.ts
│   │       ├── 4-code.ts
│   │       ├── 5-git.ts
│   │       ├── 6-review.ts
│   │       ├── 7-deploy.ts
│   │       ├── 8-test.ts
│   │       └── 9-notify.ts
│   │
│   ├── integrations/
│   │   ├── jira/
│   │   │   ├── client.ts               # Multi-tenant Jira REST client (from jira-mcp)
│   │   │   └── tools.ts                # Tool implementations (from jira-mcp)
│   │   ├── github/
│   │   │   └── client.ts               # Octokit wrapper
│   │   └── telegram/
│   │       ├── bot.ts                  # grammY bot instance
│   │       ├── notifier.ts             # Send notifications
│   │       └── human-loop.ts           # Clarification request + response handler
│   │
│   ├── config/
│   │   ├── schema.ts                   # Zod schema (full project config)
│   │   ├── loader.ts                   # Load + validate + env substitution
│   │   ├── wizard.ts                   # jiraACP init interactive setup
│   │   └── defaults.ts
│   │
│   ├── memory/
│   │   ├── claude-md.ts                # CLAUDE.md generator from codebase scan
│   │   ├── mcp-json.ts                 # .mcp.json generator
│   │   └── context-builder.ts          # Per-run memory file assembly
│   │
│   └── utils/
│       ├── lock.ts                     # O_EXCL lock file (crash-safe)
│       ├── logger.ts                   # Structured logger (pino)
│       └── process.ts                  # Subprocess + timeout management
│
├── SPEC.md
├── ARCHITECTURE.md
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Key Components

### 1. Pipeline Orchestrator (`pipeline/orchestrator.ts`)

The central coordinator. Runs stages sequentially, handles failures, manages concurrency.

```typescript
interface PipelineContext {
  config: ProjectConfig
  ticketKey: string
  state: PipelineState
  jira: JiraClient
  github: GitHubClient
  telegram: TelegramNotifier
  logger: Logger
}

interface Stage {
  id: StageId
  name: string
  model: 'haiku' | 'sonnet' | 'opus'
  timeoutMs: number
  run(ctx: PipelineContext): Promise<StageOutput>
  skip?(ctx: PipelineContext): Promise<boolean>
}

async function runPipeline(ticketKey: string, config: ProjectConfig): Promise<void> {
  const ctx = buildContext(ticketKey, config)
  const lock = await acquireLock(ticketKey)

  try {
    for (const stage of STAGES) {
      if (await stage.skip?.(ctx)) continue
      ctx.state.emit({ type: 'STAGE_STARTED', stage: stage.id })
      const output = await withTimeout(stage.run(ctx), stage.timeoutMs)
      ctx.state.emit({ type: 'STAGE_COMPLETED', stage: stage.id, output })
    }
    ctx.state.emit({ type: 'PIPELINE_COMPLETED' })
  } catch (err) {
    ctx.state.emit({ type: 'PIPELINE_ABORTED', reason: String(err) })
    await ctx.telegram.notifyError(ticketKey, err)
  } finally {
    lock.release()
  }
}
```

### 2. State Machine (`pipeline/state.ts`)

Append-only event log. Replaying events always produces the same derived state (crash-safe).

```typescript
type PipelineEvent =
  | { type: 'STARTED'; timestamp: string }
  | { type: 'STAGE_STARTED'; stage: StageId; timestamp: string }
  | { type: 'STAGE_COMPLETED'; stage: StageId; output: unknown; timestamp: string }
  | { type: 'STAGE_FAILED'; stage: StageId; error: string; timestamp: string }
  | { type: 'CLARIFICATION_REQUESTED'; questions: string[]; timestamp: string }
  | { type: 'CLARIFICATION_RECEIVED'; answers: string; timestamp: string }
  | { type: 'PIPELINE_COMPLETED' | 'PIPELINE_ABORTED'; timestamp: string }

// Derived state computed by replay
function deriveState(events: PipelineEvent[]): PipelineState {
  return events.reduce(applyEvent, INITIAL_STATE)
}

// Append-only — never mutate existing events
function appendEvent(runDir: string, event: PipelineEvent): void {
  const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() })
  fs.appendFileSync(path.join(runDir, 'state.json'), line + '\n')
}
```

### 3. Claude Runner (`pipeline/runner.ts`)

Spawns Claude Code as a subprocess using `spawn` (not `exec` — avoids shell injection).
Based on OpenACP's `AgentInstance` pattern.

```typescript
interface RunAgentOptions {
  prompt: string
  workdir: string
  model: 'haiku' | 'sonnet' | 'opus'
  contextFiles: string[]
  timeoutMs: number
  stallTimeoutMs: number
  env?: Record<string, string>   // minimal allowlist — never full process.env
}

async function runAgent(opts: RunAgentOptions): Promise<string> {
  // spawn (not exec) — args are passed as array, no shell injection risk
  const proc = spawn('claude', buildArgs(opts), {
    cwd: opts.workdir,
    env: buildMinimalEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe']
  })

  return collectOutput(proc, {
    timeout: opts.timeoutMs,
    stallTimeout: opts.stallTimeoutMs
  })
}

// Only forward what the agent needs — never spread process.env
function buildMinimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] ?? '',
    ...extra
  }
}
```

### 4. Human-in-the-Loop (`integrations/telegram/human-loop.ts`)

Sends clarification requests and waits for human response via Promise + persistent store.

```typescript
interface PendingClarification {
  ticketKey: string
  messageId: number
  questions: string[]
  createdAt: string
  expiresAt: string
  // resolve/reject not persisted — re-registered on bot startup
}

async function requestClarification(
  ticketKey: string,
  questions: string[],
  opts: { timeoutMs: number; onTimeout: TimeoutAction }
): Promise<string> {
  const msg = await bot.api.sendMessage(chatId, formatClarification(ticketKey, questions))
  pendingStore.add({ ticketKey, messageId: msg.message_id, questions, ... })

  return new Promise((resolve, reject) => {
    pendingStore.registerHandlers(ticketKey, resolve, reject)
    scheduleTimeoutReminders(ticketKey, opts)
  })
}

// Bot command handler
bot.command('answer', (ctx) => {
  const lines = ctx.message?.text?.split('\n') ?? []
  const ticketKey = lines[0]?.trim().replace('/answer ', '')
  const answers = lines.slice(1).join('\n')
  pendingStore.resolve(ticketKey, answers)
})
```

### 5. Multi-Tenant Jira Client (`integrations/jira/client.ts`)

Absorbed from `jira-mcp`. Auto-discovers instances from env vars.

```typescript
// Auto-discover from: JIRA_{NAME}_URL, JIRA_{NAME}_TOKEN, JIRA_{NAME}_EMAIL
function loadInstances(): Record<string, JiraConfig> {
  const instances: Record<string, JiraConfig> = {}
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^JIRA_([A-Z0-9]+)_URL$/)
    if (!match) continue
    const name = match[1].toLowerCase()
    const upper = match[1]
    const url = process.env[`JIRA_${upper}_URL`]
    const token = process.env[`JIRA_${upper}_TOKEN`]
    const email = process.env[`JIRA_${upper}_EMAIL`]
    if (url && token && email) instances[name] = { url, token, email }
  }
  return instances
}
```

### 6. Memory Builder (`memory/`)

```typescript
// claude-md.ts: scan codebase → generate CLAUDE.md
async function generateClaudeMd(workspace: string, config: ProjectConfig): Promise<string>

// mcp-json.ts: write .claude/.mcp.json pointing to jiraACP-mcp binary
async function writeMcpJson(workspace: string, config: ProjectConfig): Promise<void>

// context-builder.ts: assemble per-run memory files before each stage
async function buildStageContext(ctx: PipelineContext, stage: StageId): Promise<string[]>
```

---

## Data Flow

### Full pipeline run (happy path)

```
jiraACP run PROJ-123
  │
  ├─ Config: {workspace}/.jira-acp/project.json
  ├─ Lock: runs/PROJ-123/PROJ-123.lock (O_EXCL)
  ├─ Event: STARTED
  │
  ├─ Stage 1 — Fetch (Haiku)
  │    jira.getTasks({ instance, assignees }) → JiraTask[]
  │    Write: ticket-context.md
  │
  ├─ Stage 2 — Analyze (Sonnet)
  │    claude --print "Score clarity..." → { score: 0.85, missing: [] }
  │    score ≥ threshold → Stage 3 skipped
  │
  ├─ Stage 3 — Clarify (conditional, Haiku)
  │    telegram.requestClarification(questions) → await /answer reply
  │    Append answers to ticket-context.md
  │
  ├─ Stage 4 — Code (Sonnet)
  │    spawn('claude', [...args], { cwd: workspace })
  │    contextFiles: [CLAUDE.md, ticket-context.md]
  │    → code written to workspace, code-plan.md created
  │
  ├─ Stage 5 — Git (Haiku)
  │    spawn('git', ['checkout', '-b', 'feature/PROJ-123-slug'])
  │    spawn('git', ['push', 'origin', 'feature/PROJ-123-slug'])
  │    github.createPR({ title, body }) → PR #42
  │
  ├─ Stage 6 — Review (2× Sonnet parallel)
  │    Promise.all([logicReviewAgent, qualityReviewAgent])
  │    → review-feedback.md
  │    minor issues only → github.mergePR(42)
  │
  ├─ Stage 7 — Deploy (Haiku)
  │    spawn(deployScript, [], { cwd: workspace })
  │    healthCheck(config.deploy.healthCheckUrl)
  │
  ├─ Stage 8 — Test (Sonnet + Playwright MCP)
  │    spawn('claude', ['--print', testPrompt])
  │    → pass/fail + artifacts
  │
  └─ Stage 9 — Notify (Haiku)
       jira.transitionTicket("Done")
       jira.addComment("✅ Implemented via jiraACP...")
       jira.reassign(config.jira.reassignTo)
       telegram.send("✅ PROJ-123 done. PR #42")
       Lock released
```

### Crash recovery flow

```
Process killed at Stage 4 (Code)
  │
  ├─ state.json: events up to STAGE_STARTED { stage: "code" }
  ├─ PROJ-123.lock: exists, PID dead
  │
jiraACP resume PROJ-123
  ├─ Dead lock detected → "Resume from 'code'? [Y/n]"
  ├─ Y → new lock acquired
  ├─ Replay events → currentStage = "code"
  ├─ memory/ files intact → context restored
  └─ Restart from Stage 4
```

---

## Integration Patterns

### Jira: Direct call + MCP (dual mode)

```
Pipeline stages  ──direct API──►  integrations/jira/client.ts
Claude agents    ──MCP protocol──►  jiraACP-mcp ──► same client.ts
```

No duplication — same `client.ts` and `tools.ts` serve both paths.

### GitHub: Octokit
All GitHub operations via `@octokit/rest`. Conditional ETags to avoid rate limits.
Never force-push to protected branches — always PR flow.

### Telegram: grammY
- `jiraACP run` → long polling (dev/direct)
- `jiraACP serve` → webhook (production, Jira automation rules)
- Bot is singleton per process; handlers registered at startup from `pending-clarifications.json`

### Claude Code: spawn (not exec)
- All agent invocations use `spawn` with args as array — no shell injection risk
- Minimal env forwarding: `PATH`, `HOME`, `ANTHROPIC_API_KEY`, project-specific vars only
- Stall detection: kill subprocess if no stdout for `agentStallTimeoutMs`

---

## Model Selection per Stage

| Stage | Model | Why |
|-------|-------|-----|
| 1. Fetch | Haiku | Mechanical API call |
| 2. Analyze | Haiku → Sonnet | Clarity scoring |
| 3. Clarify | Haiku | Format + send message |
| 4. Code | Sonnet (→ Opus if complex) | Core value |
| 5. Git | Haiku | Shell commands |
| 6. Review (×2) | Sonnet | Code analysis |
| 7. Deploy | Haiku | Shell commands |
| 8. Test | Sonnet | Playwright coordination |
| 9. Notify | Haiku | Jira + Telegram update |

**Complexity auto-detection (Stage 4):**
If task involves auth, payments, DB schema changes, or cross-module refactoring → upgrade to Opus.

---

## Concurrency Model

### Within one ticket
- Stages run **sequentially**
- Exception: Stage 6 spawns 2 review agents **in parallel**, outputs merged before decision

### Sprint run
- Up to `maxConcurrentRuns` ticket pipelines run **in parallel**
- Each is an isolated process with own lock + state dir
- Jira "blocks/is blocked by" links checked before scheduling — serial if dependency found

### Triage mode
- All clarity analyses run **in parallel** (max 5 workers)
- All clarification requests batched into one Telegram digest (avoids notification fatigue)

---

## Package Configuration

### package.json
```json
{
  "name": "jira-acp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "jiraACP": "./dist/cli.js",
    "jiraACP-mcp": "./dist/mcp.js"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "axios": "^1.7.0",
    "commander": "^12.0.0",
    "grammy": "^1.30.0",
    "@octokit/rest": "^21.0.0",
    "zod": "^3.23.0",
    "pino": "^9.0.0",
    "@clack/prompts": "^0.7.0",
    "picocolors": "^1.1.0"
  }
}
```

### tsup.config.ts
```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    mcp: 'src/mcp.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
})
```

---

## Security Rules (non-negotiable)

| Rule | Implementation |
|------|---------------|
| No secrets in config files | `"env:VAR_NAME"` references, `jiraACP doctor` warns on plaintext |
| No full env forwarding to agents | `buildMinimalEnv()` — only `PATH`, `HOME`, `ANTHROPIC_API_KEY` |
| No shell injection | Always `spawn(cmd, argsArray)` — never `exec(templateString)` |
| Agent path scoping | `workspace.allowedPaths` enforced in runner |
| Telegram chat filtering | Only accept messages from configured `chatId` |
| Lock files atomic | `O_EXCL` open flag — fail if exists |
| Audit trail | All external state mutations logged to `audit.log` with tokens redacted |

---

## File Conventions

| Convention | Rule |
|-----------|------|
| File naming | `kebab-case` files, `PascalCase` types, `camelCase` functions |
| TypeScript | No `any`, explicit return types on exports |
| Logging | `pino` structured logger — no `console.log` in production |
| Errors | Custom classes extending `Error` per integration domain |
| Subprocess | Always `spawn(bin, argsArray)` — never `exec(shellString)` |
| Secrets | `"env:VAR_NAME"` in config, never literal tokens |

---

## Reuse from jira-mcp

| Source | Destination | Changes |
|--------|-------------|---------|
| `jira-mcp/src/client.ts` | `src/integrations/jira/client.ts` | None |
| `jira-mcp/src/tools.ts` | `src/integrations/jira/tools.ts` | None |
| `jira-mcp/src/index.ts` | `src/mcp.ts` | Keep multi-tenant, remove single-instance option |

## Reuse from OpenACP

| Pattern | Used in jiraACP |
|---------|----------------|
| `AgentInstance` subprocess | `pipeline/runner.ts` |
| Zod config + env override | `config/schema.ts` + `config/loader.ts` |
| grammY bot setup | `integrations/telegram/bot.ts` |
| tsup dual-entry | `tsup.config.ts` (add `mcp` entry) |

---

## Build Roadmap

### Sprint 1 — Core (Weeks 1-3)
```
Week 1: package.json + tsconfig + tsup, config schema, CLI skeleton, jira client absorbed
Week 2: Pipeline state machine, orchestrator, stages 1+2+9, jiraACP doctor
Week 3: Claude runner, stages 4+5, GitHub client, memory builder, jiraACP status
```

### Sprint 2 — Human Loop + Quality (Weeks 4-6)
```
Week 4: Telegram bot, human-loop, stage 3+6, resume logic
Week 5: Stages 7+8, sprint command, triage, cost tracking
Week 6: Schedule, serve webhook, dashboard, npm publish
```
