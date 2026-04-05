# TASKS.md — jiraACP Sprint 3

## Architecture-confirmed: true

## Sprint 3 scope

Implement the 10 remaining SPEC.md features absent from Sprint 1+2:
token cost tracking (`usage`), event log pretty-printer (`replay`), process suspension
(`pause`), clarification cancellation (`cancel-clarification`), config mutation commands
(`config set` / `config edit`), project management commands (`projects list/add/remove`),
pipeline lifecycle hooks, cost-limit enforcement, and append-only audit log.

All tasks follow established patterns: `StateManager` from `src/pipeline/state.ts`,
`loadConfig` / `listProjects` from `src/config/loader.ts`, `readLockData` from
`src/utils/lock.ts`, `spawnSafe` from `src/utils/process.ts`, `createLogger` from
`src/utils/logger.ts`. No `any`, explicit return types, `.js` ESM imports.

---

## Wave 1 — Standalone commands (no inter-task deps)

### TASK-001 — `jiraACP replay <ticketKey>`

- [x] Status: complete
- File: `src/commands/replay.ts` (new), `src/pipeline/state.ts` (add `getEvents` export), `src/cli.ts` (register command)
- Scope:
  - Add exported helper to `src/pipeline/state.ts`:
    ```typescript
    export function getEvents(runDir: string): PipelineEvent[]
    ```
    Reads `state.json`, returns parsed event array (same logic as `StateManager.load()` — extract and export it)
  - Export `replayRun(ticketKey: string, projectName: string): Promise<void>` from `src/commands/replay.ts`
  - Load events via `getEvents(getRunDir(projectName, ticketKey))`; exit 1 if file not found
  - Pretty-print each event chronologically using `picocolors`:
    - `STARTED` → cyan header with ticketKey + timestamp
    - `STAGE_STARTED` / `STAGE_COMPLETED` / `STAGE_SKIPPED` → stage badge + elapsed ms between STARTED and COMPLETED
    - `STAGE_FAILED` → red with error text
    - `CLARIFICATION_REQUESTED` → yellow bullet list of questions
    - `CLARIFICATION_RECEIVED` → green with answers preview (first 80 chars)
    - `PIPELINE_COMPLETED` → green success summary with total elapsed
    - `PIPELINE_ABORTED` → red with reason
  - Read-only: no writes, no side effects, no Telegram calls
  - Register in `src/cli.ts`:
    ```
    jiraACP replay <ticketKey> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  jiraACP replay PROJ-123 --project my-saas
  # prints all events in order, coloured, with timestamps
  # exits 0 for completed or in-progress runs
  # exits 1 with error message if PROJ-123 has no state file
  ```

---

### TASK-002 — `jiraACP pause <ticketKey>`

- [x] Status: complete
- File: `src/commands/pause.ts` (new), `src/cli.ts` (register command)
- Scope:
  - Export `pausePipeline(ticketKey: string, projectName: string): Promise<void>`
  - Read lock via `readLockData(getLockPath(projectName, ticketKey))`
  - If no lock file: `process.stderr.write('No running pipeline found for <ticketKey>\n')`, exit 1
  - Check `lockData.pid` is alive using `process.kill(pid, 0)` inside try/catch; if ESRCH: print error, exit 1
  - Send `SIGSTOP` to `lockData.pid` via `process.kill(pid, 'SIGSTOP')`
  - Handle ESRCH on SIGSTOP (race condition — process died between check and signal): print warning, exit 0
  - Print: `✓ Pipeline PROJ-123 paused (PID <pid>). Resume with: jiraACP resume PROJ-123`
  - Register in `src/cli.ts`:
    ```
    jiraACP pause <ticketKey> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  # Start a long pipeline, then in another terminal:
  jiraACP pause PROJ-123 --project my-saas
  # process suspended (SIGSTOP), prints confirmation
  jiraACP resume PROJ-123 --project my-saas
  # pipeline continues from last checkpoint
  ```

---

### TASK-003 — `jiraACP cancel-clarification <ticketKey>`

- [x] Status: complete
- File: `src/commands/cancel-clarification.ts` (new), `src/cli.ts` (register command)
- Scope:
  - Export `cancelClarification(ticketKey: string, projectName: string): Promise<void>`
  - Pending clarifications file: `PENDING_FILE = path.join(os.homedir(), '.jira-acp', 'pending-clarifications.json')`
  - Read file (if missing or empty array: treat as no entry); filter out object where `.ticketKey === ticketKey`; write back
  - If no matching entry found: print `No pending clarification found for <ticketKey>`, exit 0
  - Emit `CLARIFICATION_RECEIVED` event with `answers: 'CANCELLED'` into the run's `StateManager`
    so state reflects the cancellation for dead-process scenarios
  - Print: `✓ Clarification for <ticketKey> cancelled`
  - Register in `src/cli.ts`:
    ```
    jiraACP cancel-clarification <ticketKey> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  # With a pending entry in pending-clarifications.json for PROJ-123:
  jiraACP cancel-clarification PROJ-123 --project my-saas
  # pending-clarifications.json no longer has PROJ-123
  # state.json has CLARIFICATION_RECEIVED { answers: "CANCELLED" }

  # Without a pending entry:
  jiraACP cancel-clarification PROJ-456 --project my-saas
  # "No pending clarification found for PROJ-456", exit 0
  ```

---

### TASK-004 — `jiraACP config set <key> <value>`

- [x] Status: complete
- File: `src/commands/config-set.ts` (new), `src/cli.ts` (extend `config` command group)
- Scope:
  - Export `configSet(projectName: string, key: string, rawValue: string): Promise<void>`
  - Config file path: `path.join(os.homedir(), '.jira-acp', 'projects', projectName + '.json')`
  - Exit 1 with message if file not found
  - Read raw JSON with `JSON.parse(fs.readFileSync(...))` — do NOT run through zod loader
    (preserves `"env:VAR_NAME"` references and unrecognised keys)
  - Parse `rawValue`:
    - Try `JSON.parse(rawValue)` first; if that throws, treat as plain string
  - Helper (unexported): `setDotPath(obj: Record<string, unknown>, dotKey: string, value: unknown): void`
    — splits on `.`, traverses and creates nested objects as needed, sets leaf
  - Write back with `JSON.stringify(obj, null, 2) + '\n'`
  - Validate mutated config with zod schema from `src/config/schema.ts`; if invalid:
    restore backup bytes and exit 1 with first validation error message
  - Print: `✓ Set <key> = <rawValue> in project <projectName>`
  - Register in `src/cli.ts` under `config` command group:
    ```
    jiraACP config set <key> <value> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  jiraACP config set pipeline.maxConcurrentRuns 3 --project my-saas
  jiraACP config get pipeline.maxConcurrentRuns --project my-saas
  # prints: 3

  jiraACP config set github.autoMergeStrategy squash --project my-saas
  jiraACP config get github.autoMergeStrategy --project my-saas
  # prints: "squash"
  ```

---

### TASK-005 — `jiraACP config edit`

- [x] Status: complete
- File: `src/commands/config-edit.ts` (new), `src/cli.ts` (extend `config` command group)
- Scope:
  - Export `configEdit(projectName: string): Promise<void>`
  - Config file path: `path.join(os.homedir(), '.jira-acp', 'projects', projectName + '.json')`
  - Exit 1 with message if file not found
  - Determine editor: `process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'nano'`
  - Open via `spawnSafe` from `src/utils/process.ts` with `stdio: 'inherit'` so user can type:
    ```typescript
    await spawnSafe(editor, [configPath], { stdio: 'inherit' })
    ```
  - After editor exits, validate with zod schema from `src/config/schema.ts`; if invalid:
    log each error with pino at `warn` level and print:
    `Warning: config may be invalid — run: jiraACP doctor`
  - On valid: print `✓ Config saved`
  - Register in `src/cli.ts` under `config` command group:
    ```
    jiraACP config edit [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  EDITOR=nano jiraACP config edit --project my-saas
  # opens nano with the JSON config
  # on save+exit: validates and prints result
  ```

---

### TASK-006 — `jiraACP projects list/add/remove`

- [x] Status: complete
- File: `src/commands/projects.ts` (new), `src/config/defaults.ts` (add `getDefaultConfigTemplate`), `src/cli.ts` (register `projects` command group)
- Scope:
  - `PROJECTS_DIR = path.join(os.homedir(), '.jira-acp', 'projects')`
  - `projectsList(): void`
    - `fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'))`; if none: `No projects configured. Run: jiraACP init`
    - For each, read and parse JSON, print row: `<name>  <jira.projectKey>  <workspace.rootDir>`
    - Use `picocolors` for column alignment (pad with spaces)
  - `projectsAdd(name: string): Promise<void>`
    - Exit 1 if `<PROJECTS_DIR>/<name>.json` already exists
    - Call `getDefaultConfigTemplate(name): Record<string, unknown>` from `src/config/defaults.ts`
      — returns the minimal valid config skeleton with placeholder strings like `"env:JIRA_..."`;
      update `defaults.ts` to export this function
    - Write file with `JSON.stringify(template, null, 2) + '\n'`
    - Print: `✓ Created ~/.jira-acp/projects/<name>.json — fill in credentials before running`
  - `projectsRemove(name: string): Promise<void>`
    - Exit 1 if file not found
    - Prompt: `import { confirm } from '@clack/prompts'` then `await confirm({ message: \`Delete project '${name}'? This is irreversible.\` })`
    - On `true`: `fs.unlinkSync(configPath)`; print `✓ Project '<name>' removed`
    - On `false` or cancel: print `Cancelled.`, exit 0
  - Register in `src/cli.ts`:
    ```
    jiraACP projects list
    jiraACP projects add <name>
    jiraACP projects remove <name>
    ```
- Deps: none
- Acceptance:
  ```
  jiraACP projects list          # shows table
  jiraACP projects add new-proj  # creates file, prints path
  jiraACP projects remove new-proj  # prompts, deletes on confirm
  ```

---

### TASK-007 — `jiraACP usage [--month YYYY-MM]`

- [x] Status: complete
- File: `src/commands/usage.ts` (new), `src/utils/pricing.ts` (new), `src/cli.ts` (register command)
- Scope:
  - Create `src/utils/pricing.ts`:
    ```typescript
    export interface ModelPricing {
      inputPer1M: number
      outputPer1M: number
    }

    export const MODEL_PRICING: Record<string, ModelPricing> = {
      'claude-haiku-4':   { inputPer1M: 0.25,  outputPer1M: 1.25 },
      'claude-sonnet-4':  { inputPer1M: 3.00,  outputPer1M: 15.00 },
      'claude-opus-4':    { inputPer1M: 15.00, outputPer1M: 75.00 },
    }

    export function estimateCostUsd(
      inputTokens: number,
      outputTokens: number,
      model: string,
    ): number
    ```
    — looks up `MODEL_PRICING[model]`, falls back to sonnet pricing if unknown
  - Export `showUsage(opts: { month?: string; project?: string; verbose?: boolean }): Promise<void>`
  - Scan `~/.jira-acp/runs/<project>/<ticketKey>/state.json` recursively
  - For each state file: load events, find `STARTED` event to get month, filter by `--month` if provided
  - Extract `STAGE_COMPLETED` events where `(event.output as Record<string, unknown>).tokenUsage` exists
    with shape `{ inputTokens: number; outputTokens: number; model: string }`
  - Aggregate per project: summed tokens + `estimateCostUsd` from `src/utils/pricing.ts`
  - Print table: `Project | Runs | Input tokens | Output tokens | Est. cost USD`
  - With `--verbose`: also print per-stage breakdown under each project row
  - Register in `src/cli.ts`:
    ```
    jiraACP usage [--month YYYY-MM] [--project <name>] [--verbose]
    ```
- Deps: none (reads existing state files; graceful degradation if `tokenUsage` absent)
- Acceptance:
  ```
  jiraACP usage
  # prints cost table for all projects, all time

  jiraACP usage --month 2025-04 --project my-saas
  # filtered to April 2025 runs for my-saas only

  jiraACP usage --verbose
  # includes per-stage token breakdown
  ```

---

## Wave 2 — Features requiring orchestrator/stage integration (depends on Wave 1)

### TASK-008 — Pipeline hooks (`beforePipeline`, `beforeCode`, `afterCode`, `afterDeploy`, `afterPipeline`)

- [x] Status: complete
- File: `src/pipeline/hooks.ts` (new), `src/pipeline/orchestrator.ts` (inject hook calls)
- Scope:
  - Create `src/pipeline/hooks.ts`:
    ```typescript
    import type { Logger } from 'pino'

    export type HookName =
      | 'beforePipeline'
      | 'beforeCode'
      | 'afterCode'
      | 'afterDeploy'
      | 'afterPipeline'

    export class HookError extends Error {
      constructor(
        public readonly hookName: HookName,
        public readonly exitCode: number,
      ) {
        super(`Hook '${hookName}' failed with exit code ${exitCode}`)
        this.name = 'HookError'
      }
    }

    export async function runHook(
      name: HookName,
      command: string | undefined,
      ctx: { ticketKey: string; logger: Logger },
    ): Promise<void>
    ```
  - If `command` is undefined or empty string: return (no-op)
  - Split: `const [bin, ...args] = command.trim().split(/\s+/)`
  - Execute: `await spawnSafe(bin, args, { stdio: 'inherit', env: buildMinimalEnv({ JIRA_ACP_TICKET: ctx.ticketKey }) })`
  - If non-zero exit: throw `HookError(name, exitCode)`
  - Log hook start (`info`) and completion (`info`) or failure (`error`) with pino
  - Inject into `src/pipeline/orchestrator.ts`:
    - `beforePipeline` — before the stage loop, after lock acquired
    - `beforeCode` — before stage 4 `run()` call (check `stage.id === 'code'`)
    - `afterCode` — after stage 4 `STAGE_COMPLETED` event emitted
    - `afterDeploy` — after stage 7 `STAGE_COMPLETED` event emitted
    - `afterPipeline` — in `finally` block (runs even on abort/failure)
  - Orchestrator wraps `HookError` → emits `PIPELINE_ABORTED` with the error message before re-throwing
  - Read commands from `config.pipeline.hooks[name] as string | undefined`
- Deps: Wave 1 merged (ensures orchestrator structure is stable before patching)
- Acceptance:
  ```json
  {
    "pipeline": {
      "hooks": {
        "beforeCode": "scripts/before-code.sh",
        "afterPipeline": "scripts/notify-slack.sh"
      }
    }
  }
  ```
  ```
  jiraACP run PROJ-123 --project my-saas
  # scripts/before-code.sh runs before stage 4
  # scripts/notify-slack.sh runs in finally block regardless of outcome
  # If before-code.sh exits 1: pipeline aborts with HookError message
  ```

---

### TASK-009 — Cost limit enforcement (`maxCostUsdPerRun`)

- [x] Status: complete
- File: `src/pipeline/cost-guard.ts` (new), `src/pipeline/orchestrator.ts` (call guard between stages)
- Scope:
  - Create `src/pipeline/cost-guard.ts`:
    ```typescript
    import type { TelegramNotifier } from '../integrations/telegram/notifier.js'

    export async function checkCostLimit(opts: {
      runDir: string
      maxCostUsd: number
      telegram: TelegramNotifier
      ticketKey: string
    }): Promise<'continue' | 'abort'>
    ```
  - Implementation:
    1. Call `getEvents(opts.runDir)` (exported from `src/pipeline/state.ts` in TASK-001)
    2. Collect `tokenUsage` from each `STAGE_COMPLETED` event's `output` field
       (guard with `typeof output === 'object' && output !== null && 'tokenUsage' in output`)
    3. Sum cost using `estimateCostUsd` from `src/utils/pricing.ts` (from TASK-007)
    4. If `totalCost >= opts.maxCostUsd`:
       - `await opts.telegram.send(...)` with message:
         `[jiraACP] Cost limit reached ($<total> / $<max>) for <ticketKey>. Aborting.`
       - return `'abort'`
    5. If `totalCost >= 0.8 * opts.maxCostUsd`:
       - `await opts.telegram.send(...)` warning about 80% threshold
       - return `'continue'`
    6. Otherwise: return `'continue'`
  - Inject into `src/pipeline/orchestrator.ts`: after each `STAGE_COMPLETED` event is emitted,
    if `config.pipeline.maxCostUsdPerRun` is defined and > 0:
    call `checkCostLimit(...)`; if `'abort'`: emit `PIPELINE_ABORTED` and throw
  - Only active when `maxCostUsdPerRun` is defined
- Deps: TASK-001 (`getEvents` export), TASK-007 (`src/utils/pricing.ts`)
- Acceptance:
  ```json
  { "pipeline": { "maxCostUsdPerRun": 0.05 } }
  ```
  ```
  # When cumulative cost after any stage exceeds $0.05:
  # Telegram message sent ("Cost limit reached")
  # PIPELINE_ABORTED emitted in state.json
  # jiraACP run exits with code 1

  # When cost crosses 80% ($0.04):
  # Telegram warning sent, pipeline continues
  ```

---

### TASK-010 — Append-only audit log (`~/.jira-acp/audit.log`)

- [x] Status: complete
- File: `src/utils/audit.ts` (new); call sites in `src/pipeline/stages/9-notify.ts`, `src/pipeline/stages/5-git.ts`, `src/pipeline/stages/6-review.ts`, `src/integrations/telegram/notifier.ts`
- Scope:
  - Create `src/utils/audit.ts`:
    ```typescript
    export type AuditAction =
      | 'JIRA_STATUS_CHANGED'
      | 'JIRA_COMMENT_ADDED'
      | 'JIRA_REASSIGNED'
      | 'GITHUB_PR_CREATED'
      | 'GITHUB_PR_MERGED'
      | 'TELEGRAM_MESSAGE_SENT'

    export interface AuditEntry {
      timestamp: string
      project: string
      ticketKey: string
      action: AuditAction
      detail: Record<string, string | number | boolean>
    }

    export function writeAuditEntry(
      entry: Omit<AuditEntry, 'timestamp'>,
    ): void
    ```
  - `AUDIT_FILE = path.join(os.homedir(), '.jira-acp', 'audit.log')`
  - `writeAuditEntry`: `fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ...entry, timestamp }) + '\n')`
  - Token redaction: before writing, iterate `entry.detail` values; if a string value matches
    `/^[A-Za-z0-9\-_]{31,}$/` replace it with `'<redacted>'`
  - Add call sites (each must pass `project` and `ticketKey` from pipeline `ctx`):
    - `src/pipeline/stages/9-notify.ts` — after `jira.transitionTicket(...)` resolves → `JIRA_STATUS_CHANGED` with `{ toStatus: string }`
    - `src/pipeline/stages/9-notify.ts` — after `jira.addComment(...)` resolves → `JIRA_COMMENT_ADDED` with `{ commentLength: number }`
    - `src/pipeline/stages/9-notify.ts` — after `jira.reassign(...)` resolves → `JIRA_REASSIGNED` with `{ assignee: string }`
    - `src/pipeline/stages/5-git.ts` — after `github.createPR(...)` resolves → `GITHUB_PR_CREATED` with `{ prNumber: number, url: string }`
    - `src/pipeline/stages/6-review.ts` — after `github.mergePR(...)` resolves → `GITHUB_PR_MERGED` with `{ prNumber: number, strategy: string }`
    - `src/integrations/telegram/notifier.ts` — after each `bot.api.sendMessage(...)` resolves → `TELEGRAM_MESSAGE_SENT` with `{ messageId: number }`
  - `writeAuditEntry` is synchronous (append-only, no async needed); wrap each call site in
    try/catch to prevent audit failure from breaking the pipeline
- Deps: Wave 1 merged (code review of stages must be stable before adding call sites)
- Acceptance:
  ```
  jiraACP run PROJ-123 --project my-saas   # complete run to stage 9
  cat ~/.jira-acp/audit.log
  # One JSON line per external mutation, e.g.:
  # {"timestamp":"2025-04-05T09:00:00.000Z","project":"my-saas","ticketKey":"PROJ-123","action":"GITHUB_PR_CREATED","detail":{"prNumber":42,"url":"https://github.com/.../pull/42"}}
  # {"timestamp":"...","action":"TELEGRAM_MESSAGE_SENT","detail":{"messageId":999}}
  # No token strings (> 30 alphanum chars) appear anywhere in the file
  ```

---

## Definition of Done (all tasks)

- `npm run build` exits 0 with zero TypeScript errors
- No `any` — use `unknown` + type guard where dynamic types are needed
- All new exports have explicit return types
- All imports use `.js` extension (ESM)
- No `console.log` in production paths — pino logger only
- All subprocess calls use `spawnSafe` (never `exec`)
- New commands registered in `src/cli.ts` with `--project` option following existing pattern
