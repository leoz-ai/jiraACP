import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { confirm } from "@clack/prompts";
import pc from "picocolors";
import { listProjects, HOME_DIR, loadConfig } from "../config/loader.js";

const PROJECTS_DIR = path.join(HOME_DIR, "projects");

export function projectsList(): void {
  const names = listProjects();

  if (names.length === 0) {
    process.stdout.write(
      pc.yellow("No projects configured. Run: jiraACP init\n"),
    );
    return;
  }

  const COL1 = 20;
  const COL2 = 18;

  const pad = (s: string, w: number): string => s.padEnd(w);

  process.stdout.write(
    pc.bold(`  ${pad("Name", COL1)}${pad("Jira Project", COL2)}Workspace\n`),
  );
  process.stdout.write(
    pc.dim(`  ${"-".repeat(COL1)}${"-".repeat(COL2)}${"-".repeat(30)}\n`),
  );

  for (const name of names) {
    try {
      const config = loadConfig(name);
      const projectKey = config.jira.projectKey;
      const rootDir = config.workspace.rootDir.replace(os.homedir(), "~");
      process.stdout.write(
        `  ${pad(pc.cyan(name), COL1 + 9)}${pad(pc.green(projectKey), COL2 + 9)}${rootDir}\n`,
      );
    } catch {
      process.stdout.write(
        `  ${pad(pc.red(name), COL1 + 9)}${pad(pc.dim("(invalid)"), COL2 + 9)}${pc.dim("parse error")}\n`,
      );
    }
  }
}

export async function projectsAdd(name: string): Promise<void> {
  const filePath = path.join(PROJECTS_DIR, `${name}.json`);

  if (fs.existsSync(filePath)) {
    process.stderr.write(
      pc.red(`Error: Project '${name}' already exists at ${filePath}\n`),
    );
    process.exit(1);
  }

  const skeleton = {
    name,
    jira: {
      instance: "default",
      url: "https://your-org.atlassian.net",
      email: "you@example.com",
      token: "",
      projectKey: "PROJ",
      assignees: ["your-jira-accountid"],
      clarityScoreThreshold: 0.7,
      requiredFields: ["description"],
    },
    github: {
      owner: "your-org",
      repo: name,
      token: "",
      defaultBranch: "main",
      branchPattern: "feature/{ticketKey}-{slug}",
      autoMergeStrategy: "squash",
      reviewers: [],
      majorIssueThreshold: 1,
    },
    workspace: {
      rootDir: "/path/to/workspace",
      allowedPaths: ["."],
    },
    telegram: {
      botToken: "",
      chatId: "",
    },
    pipeline: {
      maxConcurrentRuns: 2,
    },
  };

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(skeleton, null, 2));

  const displayPath = filePath.replace(os.homedir(), "~");
  process.stdout.write(
    pc.green(`✓ Created ${displayPath} — fill in credentials before running\n`),
  );
}

export async function projectsRemove(name: string): Promise<void> {
  const filePath = path.join(PROJECTS_DIR, `${name}.json`);

  if (!fs.existsSync(filePath)) {
    process.stderr.write(
      pc.red(`Error: Project '${name}' not found at ${filePath}\n`),
    );
    process.exit(1);
  }

  const confirmed = await confirm({
    message: `Delete project '${name}'? This is irreversible.`,
    initialValue: false,
  });

  // @clack/prompts returns symbol when user cancels (Ctrl+C)
  if (typeof confirmed !== "boolean" || !confirmed) {
    process.stdout.write("Cancelled.\n");
    process.exit(0);
  }

  fs.unlinkSync(filePath);
  process.stdout.write(pc.green(`✓ Project '${name}' removed\n`));
}
