# jiraACP — Claude Code Guidelines

## Stack
- TypeScript/Node.js 20+, ESM modules (`"type": "module"`)
- Build: `npm run build` (tsup + DTS — zero errors required)
- 2 binaries: `jiraACP` (CLI) + `jiraACP-mcp` (MCP server)

## Coding Rules
- No `any` — use `unknown` + type guard
- Explicit return types on all exported functions
- kebab-case files, PascalCase types, camelCase functions
- pino logger only — no `console.log` in production code
- All subprocess calls: `spawnSafe(bin, argsArray)` from `src/utils/process.ts`
- Never spread `process.env` — use `buildMinimalEnv()`
- ESM imports must include `.js` extension

## Architecture — 5 Layers
```
CLI (commander.js)
└── Pipeline Orchestrator (stage sequencer, state machine)
    └── Stages 1–9 (business logic per stage)
        └── Integrations (Jira, GitHub, Telegram, Claude)
            └── Infrastructure (config, state, lock, logger)
```

## Config Storage
- Project configs: `~/.jira-acp/projects/<name>.json` (tokens stored directly)
- Run state: `~/.jira-acp/runs/<project>/<ticket>/state.json` (append-only event log)
- Lock files: `~/.jira-acp/runs/<project>/<ticket>/<ticket>.lock` (O_EXCL atomic)

---

# Project Pipeline

## Pipeline entry point

When starting a new session, ALWAYS do this first:

1. Check if `PIPELINE_STATE.md` exists
   - **No** → pipeline has not started. Say: "Pipeline not started. Run: `@orchestrator start`"
   - **Yes** → read it, report current phase and next action in one sentence

2. Never assume pipeline state from memory — always read `PIPELINE_STATE.md` fresh

## Commands

```
@orchestrator start          # new project — runs all 4 phases automatically
@orchestrator resume         # continue after session interruption
@orchestrator spec-updated   # SPEC.md changed — stop, diff, inject new tasks
```

## Agent roster

| Mention | Role |
|---------|------|
| `@orchestrator` | Coordinates the full pipeline |
| `@task-planner` | Generate or add tasks |
| `@architect` | Scaffold modules, write ARCH_REPORT.md |
| `@developer` | Implement a specific task |
| `@tester` | Validate a completed task |
| `@debugger` | Diagnose a failed task |

## Hard rules (apply to every agent)

- Never mark a task done without `npm run build` passing clean
- Never modify files outside the scope of the current task
- `PIPELINE_STATE.md` is the single source of truth — always read before acting
- When in doubt: stop and write a `## Blocker` note, do not guess
