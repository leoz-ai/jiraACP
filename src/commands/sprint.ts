import pc from "picocolors";
import { loadConfig } from "../config/loader.js";
import { createLogger } from "../utils/logger.js";
import { getClient as getJiraClient } from "../integrations/jira/client.js";
import { runPipeline } from "../pipeline/orchestrator.js";

export interface SprintOptions {
  projectName: string;
  sprint?: string;
  parallel: number;
  filter?: string;
  dryRun?: boolean;
}

interface JiraTicket {
  key: string;
  summary: string;
  blockedBy: string[];
}

type RunStatus = "pending" | "running" | "completed" | "failed";

interface TicketRun {
  key: string;
  status: RunStatus;
  error?: string;
}

export async function runSprint(opts: SprintOptions): Promise<void> {
  const logger = createLogger("sprint");
  const config = loadConfig(opts.projectName);
  const jiraClient = getJiraClient(config.jira.instance);

  const maxParallel = Math.min(
    opts.parallel,
    config.pipeline?.maxConcurrentRuns ?? 2,
  );

  logger.info(
    { project: opts.projectName, maxParallel },
    "Starting sprint run",
  );
  process.stdout.write(
    `\n${pc.bold("jiraACP sprint")} — ${opts.projectName}  (max ${maxParallel} parallel)\n\n`,
  );

  // Fetch sprint tickets
  process.stdout.write("Fetching sprint tickets from Jira...\n");
  let tickets: JiraTicket[];
  try {
    tickets = await fetchSprintTickets(
      jiraClient,
      config.jira.projectKey,
      config.jira.assignees,
      opts.sprint,
      opts.filter,
    );
  } catch (err) {
    process.stderr.write(
      `Failed to fetch sprint tickets: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (tickets.length === 0) {
    process.stdout.write(
      pc.gray("  No assigned tickets found in current sprint.\n\n"),
    );
    return;
  }

  process.stdout.write(
    `Found ${pc.bold(String(tickets.length))} ticket(s)\n\n`,
  );

  if (opts.dryRun) {
    process.stdout.write(pc.yellow("  --dry-run mode: would run:\n"));
    for (const t of tickets) {
      const deps =
        t.blockedBy.length > 0
          ? ` (blocked by: ${t.blockedBy.join(", ")})`
          : "";
      process.stdout.write(
        `    ${t.key}  ${pc.gray(t.summary)}${pc.red(deps)}\n`,
      );
    }
    process.stdout.write("\n");
    return;
  }

  // Build DAG and run in topological waves
  const runs = new Map<string, TicketRun>(
    tickets.map((t) => [t.key, { key: t.key, status: "pending" as RunStatus }]),
  );

  printProgress(runs);

  let anyFailed = false;

  while (hasRemaining(runs)) {
    // Find tickets ready to run: pending + all blockers completed
    const ready = tickets.filter((t) => {
      const run = runs.get(t.key);
      if (run?.status !== "pending") return false;
      return t.blockedBy.every((dep) => runs.get(dep)?.status === "completed");
    });

    if (ready.length === 0) {
      // Deadlock: remaining pending tickets all have unresolvable blockers
      const stuck = [...runs.values()].filter((r) => r.status === "pending");
      logger.warn(
        { stuck: stuck.map((s) => s.key) },
        "Sprint deadlock detected",
      );
      for (const r of stuck) {
        r.status = "failed";
        r.error = "Blocked by failed/missing dependency";
      }
      break;
    }

    // Run up to maxParallel at a time
    const batch = ready.slice(0, maxParallel);
    for (const t of batch) {
      runs.get(t.key)!.status = "running";
    }
    printProgress(runs);

    const results = await Promise.allSettled(
      batch.map(async (t) => {
        const run = runs.get(t.key)!;
        try {
          await runPipeline(t.key, config, { dryRun: opts.dryRun });
          run.status = "completed";
        } catch (err) {
          run.status = "failed";
          run.error = err instanceof Error ? err.message : String(err);
          anyFailed = true;
          logger.error({ ticketKey: t.key, err: run.error }, "Pipeline failed");
        }
      }),
    );

    // allSettled — individual errors already captured above
    void results;
    printProgress(runs);
  }

  // Final summary
  const completed = [...runs.values()].filter(
    (r) => r.status === "completed",
  ).length;
  const failed = [...runs.values()].filter((r) => r.status === "failed").length;

  process.stdout.write(
    `\n${pc.bold("Sprint complete:")}  ${pc.green(`${completed} done`)}  ${failed > 0 ? pc.red(`${failed} failed`) : ""}\n`,
  );

  if (failed > 0) {
    for (const r of runs.values()) {
      if (r.status === "failed") {
        process.stdout.write(`  ${pc.red("✗")} ${r.key}: ${r.error}\n`);
      }
    }
    process.stdout.write("\n");
  }

  if (anyFailed) process.exitCode = 1;
}

async function fetchSprintTickets(
  jiraClient: ReturnType<typeof getJiraClient>,
  projectKey: string,
  assignees: string[],
  sprint?: string,
  extraFilter?: string,
): Promise<JiraTicket[]> {
  const sprintClause = sprint
    ? `sprint = "${sprint}"`
    : `sprint in openSprints()`;

  const assigneeClause =
    assignees.length > 0
      ? `assignee in (${assignees.map((a) => `"${a}"`).join(", ")})`
      : "";

  const parts = [
    `project = "${projectKey}"`,
    sprintClause,
    assigneeClause,
    extraFilter,
  ].filter(Boolean);

  const jql = parts.join(" AND ");

  const result = (await jiraClient.searchIssues({ jql, maxResults: 50 })) as {
    issues?: Array<{
      key: string;
      fields: {
        summary: string;
        issuelinks?: Array<{
          type: { name: string; inward: string };
          inwardIssue?: { key: string };
          outwardIssue?: { key: string };
        }>;
      };
    }>;
  };

  const issues = result.issues ?? [];

  return issues.map((issue) => {
    const links = issue.fields.issuelinks ?? [];
    // "is blocked by" links: the inwardIssue is the blocker of this ticket
    const blockedBy = links
      .filter((l) => l.type.inward === "is blocked by" && l.inwardIssue)
      .map((l) => l.inwardIssue!.key);

    return {
      key: issue.key,
      summary: issue.fields.summary,
      blockedBy,
    };
  });
}

function hasRemaining(runs: Map<string, TicketRun>): boolean {
  return [...runs.values()].some(
    (r) => r.status === "pending" || r.status === "running",
  );
}

function printProgress(runs: Map<string, TicketRun>): void {
  const rows = [...runs.values()];
  const statusIcon = (r: TicketRun): string => {
    switch (r.status) {
      case "completed":
        return pc.green("✓");
      case "failed":
        return pc.red("✗");
      case "running":
        return pc.cyan("⟳");
      default:
        return pc.gray("·");
    }
  };

  process.stdout.write(
    rows.map((r) => `  ${statusIcon(r)} ${r.key}`).join("  ") + "\n",
  );
}
