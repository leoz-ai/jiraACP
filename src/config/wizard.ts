import * as p from "@clack/prompts";
import pc from "picocolors";
import { saveConfig } from "./loader.js";
import { writeMcpJson } from "../memory/mcp-json.js";
import { generateClaudeMd } from "../memory/claude-md.js";

export async function runWizard(
  projectName: string,
  projectDir: string,
): Promise<void> {
  console.log(pc.bold("\n  jiraACP — Project Setup\n"));
  p.intro(pc.cyan(`Configuring project: ${pc.bold(projectName)}`));

  const s = p.spinner();

  // ── Jira ──────────────────────────────────────────────────────────────────
  p.note("Jira configuration", "Integration");

  const jiraUrl = await p.text({
    message: "Jira URL",
    placeholder: "https://your-team.atlassian.net",
  });
  if (p.isCancel(jiraUrl)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const instanceName = projectName.toLowerCase().replace(/[^a-z0-9]/g, "");

  const jiraEmail = await p.text({ message: "Jira email" });
  if (p.isCancel(jiraEmail)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const jiraToken = await p.password({ message: "Jira API token" });
  if (p.isCancel(jiraToken)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const jiraProjectKey = await p.text({
    message: "Jira project key",
    placeholder: "PROJ",
  });
  if (p.isCancel(jiraProjectKey)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const assigneesRaw = await p.text({
    message: "Assignee Jira account IDs (comma-separated)",
    placeholder: "accountId1,accountId2",
  });
  if (p.isCancel(assigneesRaw)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const reassignTo = await p.text({
    message: "Reassign completed tickets to (accountId, optional)",
    placeholder: "reviewerAccountId",
  });
  if (p.isCancel(reassignTo)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  // ── GitHub ────────────────────────────────────────────────────────────────
  p.note("GitHub configuration", "Integration");

  const githubOwner = await p.text({ message: "GitHub owner (org or user)" });
  if (p.isCancel(githubOwner)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const githubRepo = await p.text({ message: "GitHub repository name" });
  if (p.isCancel(githubRepo)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const githubToken = await p.password({ message: "GitHub token (ghp_...)" });
  if (p.isCancel(githubToken)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  // ── Telegram ──────────────────────────────────────────────────────────────
  p.note("Telegram configuration", "Notifications");

  const telegramBotToken = await p.password({ message: "Telegram bot token" });
  if (p.isCancel(telegramBotToken)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  const telegramChatId = await p.text({
    message: "Telegram chat ID (group or user)",
    placeholder: "-100xxxxxxxxx",
  });
  if (p.isCancel(telegramChatId)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  // ── Deploy (optional) ─────────────────────────────────────────────────────
  const deployEnabled = await p.confirm({
    message: "Enable auto-deploy to dev server?",
  });
  if (p.isCancel(deployEnabled)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  let deployCommand: string | undefined;
  let healthCheckUrl: string | undefined;
  if (deployEnabled) {
    const cmd = await p.text({
      message: "Deploy command",
      placeholder: "./scripts/deploy-dev.sh",
    });
    if (p.isCancel(cmd)) {
      p.cancel("Setup cancelled");
      process.exit(0);
    }
    deployCommand = String(cmd);

    const hc = await p.text({
      message: "Health check URL (optional)",
      placeholder: "https://dev.example.com/health",
    });
    if (!p.isCancel(hc) && hc) healthCheckUrl = String(hc);
  }

  // ── Build config ──────────────────────────────────────────────────────────
  const config = {
    name: projectName,
    jira: {
      instance: instanceName,
      url: String(jiraUrl),
      email: String(jiraEmail),
      token: String(jiraToken),
      projectKey: String(jiraProjectKey).toUpperCase(),
      assignees: String(assigneesRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      reassignTo:
        reassignTo && !p.isCancel(reassignTo) ? String(reassignTo) : undefined,
    },
    github: {
      owner: String(githubOwner),
      repo: String(githubRepo),
      token: String(githubToken),
    },
    workspace: {
      rootDir: projectDir,
    },
    deploy: {
      enabled: Boolean(deployEnabled),
      command: deployCommand,
      healthCheckUrl,
    },
    telegram: {
      botToken: String(telegramBotToken),
      chatId: String(telegramChatId),
    },
  };

  // ── Save to ~/.jira-acp/projects/<name>.json ──────────────────────────────
  s.start("Saving config");
  saveConfig(projectName, config);
  s.stop(`Config saved → ~/.jira-acp/projects/${projectName}.json`);

  s.start("Generating CLAUDE.md");
  await generateClaudeMd(projectDir, config as never);
  s.stop("CLAUDE.md generated");

  s.start("Writing .mcp.json for Claude Code");
  await writeMcpJson(projectDir, config as never, instanceName);
  s.stop(".mcp.json written");

  p.outro(
    pc.green(
      `Ready! Run: ${pc.bold(`jiraACP run <TICKET-KEY> --project ${projectName}`)}`,
    ),
  );
}
