import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

// ── Daemon child mode ──────────────────────────────────────────────────────
// When spawned by startDaemon(), skip CLI parsing and go straight to serve.
const daemonIdx = process.argv.indexOf("--daemon-child");
if (daemonIdx !== -1) {
  const port = parseInt(process.argv[daemonIdx + 1] ?? "3100", 10);
  const { startServe } = await import("./commands/serve.js");
  await startServe(port);
  process.exit(0);
}

/** Resolve project name: explicit flag > auto-detect from git remote > cwd basename */
async function resolveProject(name?: string): Promise<string> {
  if (name) return name;
  const { detectProjectName } = await import("./config/loader.js");
  return detectProjectName(process.cwd());
}

const program = new Command();

program
  .name("jiraACP")
  .description(
    "AI-powered Jira pipeline: Ticket → Code → GitHub → Deploy → Notify",
  )
  .version(pkg.version);

// ── Setup ──────────────────────────────────────────────────────────────────

program
  .command("init")
  .description(
    "Interactive setup wizard — configure Jira, GitHub, Telegram, workspace",
  )
  .option("--name <name>", "Project name (default: auto-detect from git)")
  .option("--dir <path>", "Workspace root directory", process.cwd())
  .action(async (opts: { name?: string; dir: string }) => {
    const { runWizard } = await import("./config/wizard.js");
    const { detectProjectName } = await import("./config/loader.js");
    const projectName = opts.name ?? detectProjectName(opts.dir);
    await runWizard(projectName, opts.dir);
  });

program
  .command("doctor")
  .description("Health-check all integrations")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--fix", "Attempt auto-remediation")
  .action(async (opts: { project?: string; fix: boolean }) => {
    const { runDoctor } = await import("./commands/doctor.js");
    const projectName = await resolveProject(opts.project);
    await runDoctor(projectName, opts.fix);
  });

program
  .command("update-context")
  .description("Regenerate CLAUDE.md from codebase scan")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--dir <path>", "Workspace root directory", process.cwd())
  .action(async (opts: { project?: string; dir: string }) => {
    const { loadConfig } = await import("./config/loader.js");
    const { generateClaudeMd } = await import("./memory/claude-md.js");
    const projectName = await resolveProject(opts.project);
    const config = loadConfig(projectName);
    await generateClaudeMd(opts.dir, config);
    console.log("CLAUDE.md updated");
  });

// ── Pipeline ───────────────────────────────────────────────────────────────

program
  .command("run <ticketKey>")
  .description("Run the full pipeline for a single ticket")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--from <stage>", "Start from stage")
  .option("--to <stage>", "End at stage")
  .option("--dry-run", "Simulate without side effects")
  .option("--no-confirm", "Non-interactive mode")
  .action(
    async (
      ticketKey: string,
      opts: { project?: string; from?: string; to?: string; dryRun?: boolean },
    ) => {
      const { runPipeline } = await import("./pipeline/orchestrator.js");
      const { loadConfig } = await import("./config/loader.js");
      const projectName = await resolveProject(opts.project);
      const config = loadConfig(projectName);
      await runPipeline(ticketKey, config, {
        fromStage: opts.from as never,
        toStage: opts.to as never,
        dryRun: opts.dryRun,
      });
    },
  );

program
  .command("sprint")
  .description("Run pipelines for all assigned sprint tickets")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--sprint <name>", "Sprint name or ID")
  .option("--parallel <n>", "Max concurrent pipelines", "2")
  .option("--filter <jql>", "Additional JQL filter")
  .option("--dry-run", "Simulate without side effects")
  .action(
    async (opts: {
      project?: string;
      sprint?: string;
      parallel: string;
      filter?: string;
      dryRun?: boolean;
    }) => {
      const { runSprint } = await import("./commands/sprint.js");
      const projectName = await resolveProject(opts.project);
      await runSprint({
        projectName,
        sprint: opts.sprint,
        parallel: Number(opts.parallel),
        filter: opts.filter,
        dryRun: opts.dryRun,
      });
    },
  );

program
  .command("triage")
  .description("Clarity analysis only — no code changes")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--sprint <name>", "Sprint name or ID")
  .option("--dry-run", "Simulate without side effects")
  .action(
    async (opts: { project?: string; sprint?: string; dryRun?: boolean }) => {
      const { runTriage } = await import("./commands/triage.js");
      const projectName = await resolveProject(opts.project);
      await runTriage({
        projectName,
        sprint: opts.sprint,
        dryRun: opts.dryRun,
      });
    },
  );

// ── Monitoring ─────────────────────────────────────────────────────────────

program
  .command("status [ticketKey]")
  .description(
    "Show daemon status (no args) or pipeline state for a ticket key",
  )
  .option("--project <name>", "Project name (default: auto-detect, or all)")
  .action(async (ticketKey: string | undefined, opts: { project?: string }) => {
    if (!ticketKey) {
      // No arg → daemon status
      const { getStatus } = await import("./utils/daemon.js");
      const s = getStatus();
      if (s.running) {
        process.stdout.write(`jiraACP is running (PID ${s.pid})\n`);
      } else {
        process.stdout.write("jiraACP is not running\n");
      }
      return;
    }
    const { showStatus } = await import("./commands/status.js");
    const projectName = opts.project ?? (await resolveProject());
    await showStatus(projectName, ticketKey);
  });

program
  .command("logs [ticketKey]")
  .description("Show pipeline logs for a ticket, or daemon logs if no ticket")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--stage <stage>", "Show logs for specific stage only")
  .option("-f, --follow", "Tail logs for active run / daemon log")
  .option("-n <lines>", "Last N lines (daemon log only)", "50")
  .action(
    async (
      ticketKey: string | undefined,
      opts: { project?: string; stage?: string; follow?: boolean; n: string },
    ) => {
      if (!ticketKey) {
        // No ticket → tail daemon log
        const { getLogFile } = await import("./utils/daemon.js");
        const logFile = getLogFile();
        const { spawn } = await import("node:child_process");
        const args = opts.follow
          ? ["-n", opts.n, "-f", logFile]
          : ["-n", opts.n, logFile];
        const tail = spawn("tail", args, { stdio: "inherit" });
        tail.on("exit", (code) => {
          process.exitCode = code ?? 0;
        });
        return;
      }
      const { showLogs } = await import("./commands/logs.js");
      const projectName = await resolveProject(opts.project);
      await showLogs(projectName, ticketKey, opts.stage, opts.follow);
    },
  );

program
  .command("dashboard")
  .description("Terminal UI of all active runs")
  .option("--watch", "Auto-refresh every 5s")
  .action(async (opts: { watch?: boolean }) => {
    const { runDashboard } = await import("./commands/dashboard.js");
    runDashboard(opts.watch ?? false);
  });

program
  .command("replay <ticketKey>")
  .description("Pretty-print the event log for a completed run")
  .option("--project <name>", "Project name (default: auto-detect)")
  .action(async (ticketKey: string, opts: { project?: string }) => {
    const { replayRun } = await import("./commands/replay.js");
    const projectName = await resolveProject(opts.project);
    await replayRun(ticketKey, projectName);
  });

program
  .command("usage")
  .description("Token cost report per project/month")
  .option("--month <YYYY-MM>", "Filter by month")
  .option("--project <name>", "Filter by project")
  .option("--verbose", "Show per-stage breakdown")
  .action(
    async (opts: { month?: string; project?: string; verbose?: boolean }) => {
      const { showUsage } = await import("./commands/usage.js");
      await showUsage(opts);
    },
  );

// ── Control ────────────────────────────────────────────────────────────────

program
  .command("resume <ticketKey>")
  .description("Resume a paused or crashed pipeline")
  .option("--project <name>", "Project name (default: auto-detect)")
  .action(async (ticketKey: string, opts: { project?: string }) => {
    const { resumePipeline } = await import("./pipeline/orchestrator.js");
    const { loadConfig } = await import("./config/loader.js");
    const projectName = await resolveProject(opts.project);
    const config = loadConfig(projectName);
    await resumePipeline(ticketKey, config);
  });

program
  .command("abort <ticketKey>")
  .description("Abort a running pipeline")
  .option("--project <name>", "Project name (default: auto-detect)")
  .option("--reason <text>", "Abort reason")
  .action(
    async (ticketKey: string, opts: { project?: string; reason?: string }) => {
      const { abortPipeline } = await import("./commands/abort.js");
      const projectName = await resolveProject(opts.project);
      await abortPipeline(ticketKey, projectName, opts.reason);
    },
  );

program
  .command("pause <ticketKey>")
  .description("Suspend a running pipeline (SIGSTOP)")
  .option("--project <name>", "Project name (default: auto-detect)")
  .action(async (ticketKey: string, opts: { project?: string }) => {
    const { pausePipeline } = await import("./commands/pause.js");
    const projectName = await resolveProject(opts.project);
    await pausePipeline(ticketKey, projectName);
  });

program
  .command("cancel-clarification <ticketKey>")
  .description("Cancel a pending Telegram clarification")
  .option("--project <name>", "Project name (default: auto-detect)")
  .action(async (ticketKey: string, opts: { project?: string }) => {
    const { cancelClarification } =
      await import("./commands/cancel-clarification.js");
    const projectName = await resolveProject(opts.project);
    await cancelClarification(ticketKey, projectName);
  });

// ── Config ─────────────────────────────────────────────────────────────────

program
  .command("config")
  .description("Manage project config")
  .addCommand(
    new Command("get")
      .argument("[key]", "Config key (dot-path)")
      .option("--project <name>", "Project name (default: auto-detect)")
      .action(async (key: string | undefined, opts: { project?: string }) => {
        const { loadConfig } = await import("./config/loader.js");
        const projectName = await resolveProject(opts.project);
        const config = loadConfig(projectName);
        if (key) {
          const val = key
            .split(".")
            .reduce(
              (o: unknown, k) => (o as Record<string, unknown>)?.[k],
              config as unknown,
            );
          console.log(JSON.stringify(val, null, 2));
        } else {
          console.log(JSON.stringify(config, null, 2));
        }
      }),
  )
  .addCommand(
    new Command("list")
      .description("List all configured projects")
      .action(async () => {
        const { listProjects } = await import("./config/loader.js");
        const projects = listProjects();
        if (projects.length === 0) {
          console.log("No projects configured. Run: jiraACP init");
        } else {
          console.log("Configured projects:");
          for (const p of projects) console.log(`  • ${p}`);
        }
      }),
  )
  .addCommand(
    new Command("set")
      .description("Set a config key (dot-path) to a value")
      .argument("<key>", "Config key (dot-path)")
      .argument("<value>", "New value (JSON or string)")
      .option("--project <name>", "Project name (default: auto-detect)")
      .action(
        async (key: string, value: string, opts: { project?: string }) => {
          const { configSet } = await import("./commands/config-set.js");
          const projectName = await resolveProject(opts.project);
          configSet(projectName, key, value);
        },
      ),
  )
  .addCommand(
    new Command("edit")
      .description("Open config in $EDITOR")
      .option("--project <name>", "Project name (default: auto-detect)")
      .action(async (opts: { project?: string }) => {
        const { configEdit } = await import("./commands/config-edit.js");
        const projectName = await resolveProject(opts.project);
        await configEdit(projectName);
      }),
  );

// ── Projects ───────────────────────────────────────────────────────────────

const projectsCmd = program
  .command("projects")
  .description("Manage configured projects");

projectsCmd
  .command("list")
  .description("List all configured projects")
  .action(async () => {
    const { projectsList } = await import("./commands/projects.js");
    projectsList();
  });

projectsCmd
  .command("add <name>")
  .description("Create a new project config skeleton")
  .action(async (name: string) => {
    const { projectsAdd } = await import("./commands/projects.js");
    await projectsAdd(name);
  });

projectsCmd
  .command("remove <name>")
  .description("Remove a project config")
  .action(async (name: string) => {
    const { projectsRemove } = await import("./commands/projects.js");
    await projectsRemove(name);
  });

// ── Schedule ───────────────────────────────────────────────────────────────

const scheduleCmd = program
  .command("schedule")
  .description("Manage scheduled pipeline runs");

scheduleCmd
  .command("add")
  .description('Add a scheduled run (e.g. --cron "0 9 * * 1-5")')
  .requiredOption("--cron <expr>", "Cron expression (5 fields)")
  .requiredOption("--project <name>", "Project name")
  .action(async (opts: { cron: string; project: string }) => {
    const { scheduleAdd } = await import("./commands/schedule.js");
    scheduleAdd(opts.project, opts.cron);
  });

scheduleCmd
  .command("list")
  .description("List all scheduled runs")
  .action(async () => {
    const { scheduleList } = await import("./commands/schedule.js");
    scheduleList();
  });

scheduleCmd
  .command("remove <id>")
  .description("Remove a schedule by ID (or ID prefix)")
  .action(async (id: string) => {
    const { scheduleRemove } = await import("./commands/schedule.js");
    scheduleRemove(id);
  });

// ── Utility ────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start webhook server in foreground (for dev/docker)")
  .option("--port <n>", "Port number", "3100")
  .action(async (opts: { port: string }) => {
    const { startServe } = await import("./commands/serve.js");
    await startServe(Number(opts.port));
  });

// ── Daemon ─────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start jiraACP server as background daemon")
  .option("--port <n>", "Port number", "3100")
  .action(async (opts: { port: string }) => {
    const { startDaemon, getLogFile } = await import("./utils/daemon.js");
    const result = startDaemon(Number(opts.port));
    if ("error" in result) {
      process.stderr.write(`${result.error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `jiraACP started (PID ${result.pid})\nLogs: ${getLogFile()}\n`,
      );
    }
  });

program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    const { stopDaemon } = await import("./utils/daemon.js");
    const result = await stopDaemon();
    if (result.stopped) {
      process.stdout.write(`jiraACP stopped (PID ${result.pid})\n`);
    } else {
      process.stderr.write(`${result.error ?? "Failed to stop"}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("restart")
  .description("Restart the background daemon")
  .option("--port <n>", "Port number", "3100")
  .action(async (opts: { port: string }) => {
    const { stopDaemon, startDaemon, getLogFile } =
      await import("./utils/daemon.js");
    await stopDaemon();
    const result = startDaemon(Number(opts.port));
    if ("error" in result) {
      process.stderr.write(`${result.error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `jiraACP restarted (PID ${result.pid})\nLogs: ${getLogFile()}\n`,
      );
    }
  });

program.parse();
