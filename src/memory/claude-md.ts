import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config/schema.js";

export async function generateClaudeMd(
  projectDir: string,
  config: ProjectConfig,
): Promise<void> {
  const claudeDir = path.join(projectDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const stack = detectStack(projectDir);
  const upper = config.jira.instance.toUpperCase();

  const content = `# Project: ${config.name}

## Architecture Overview
This project uses an AI-powered pipeline managed by jiraACP.
Workspace: ${projectDir}

## Tech Stack
${stack}

## Jira Integration
- Instance: ${config.jira.instance}
- Project key: ${config.jira.projectKey}
- Assignees: ${config.jira.assignees.join(", ")}

## Available MCP Tools
- jira_get_tasks — fetch assigned tickets
- jira_get_ticket — get full ticket details
- jira_transition_ticket — change ticket status
- jira_add_comment — add comment to ticket
- jira_reassign — reassign ticket to another user

## Workflow Rules
- Always create a feature branch before any commits
- Branch naming: feature/{TICKET-KEY}-{short-description}
- Commit message format: "{TICKET-KEY}: {description}"
- Never modify .env files or commit secrets
- Never force-push to ${config.github.defaultBranch ?? "main"}
- All changes through PR — never commit directly to main

## GitHub
- Owner: ${config.github.owner}
- Repo: ${config.github.repo}
- Base branch: ${config.github.defaultBranch ?? "main"}

## Required Env Vars
- JIRA_${upper}_URL, JIRA_${upper}_TOKEN, JIRA_${upper}_EMAIL
- GITHUB_TOKEN
- ANTHROPIC_API_KEY
`;

  fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), content);
}

function detectStack(projectDir: string): string {
  const lines: string[] = [];

  if (fs.existsSync(path.join(projectDir, "package.json"))) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next"]) lines.push("- Framework: Next.js");
      else if (deps["@nestjs/core"]) lines.push("- Framework: NestJS");
      else if (deps["express"]) lines.push("- Framework: Express");
      if (
        deps["typescript"] ||
        fs.existsSync(path.join(projectDir, "tsconfig.json"))
      ) {
        lines.push("- Language: TypeScript");
      } else {
        lines.push("- Language: JavaScript");
      }
      if (deps["prisma"] || deps["@prisma/client"]) lines.push("- ORM: Prisma");
      if (deps["typeorm"]) lines.push("- ORM: TypeORM");
    } catch {
      /* ignore */
    }
  }

  if (
    fs.existsSync(path.join(projectDir, "pyproject.toml")) ||
    fs.existsSync(path.join(projectDir, "requirements.txt"))
  ) {
    lines.push("- Language: Python");
  }

  if (fs.existsSync(path.join(projectDir, "go.mod")))
    lines.push("- Language: Go");
  if (fs.existsSync(path.join(projectDir, "Cargo.toml")))
    lines.push("- Language: Rust");

  return lines.length > 0
    ? lines.join("\n")
    : "- (Auto-detection: update manually)";
}
