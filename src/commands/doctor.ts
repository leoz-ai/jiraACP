import pc from "picocolors";
import { spawnSafe } from "../utils/process.js";
import { configExists, loadConfig } from "../config/loader.js";
import axios from "axios";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export async function runDoctor(
  projectName: string,
  _fix: boolean,
): Promise<void> {
  console.log(pc.bold(`\n  jiraACP doctor — ${projectName}\n`));

  const results: CheckResult[] = [];

  // 1. Node version
  const nodeVersion = process.version;
  results.push({
    name: "Node.js >= 20",
    ok: parseInt(nodeVersion.slice(1)) >= 20,
    message: nodeVersion,
  });

  // 2. claude CLI (subscription-based, no API key needed)
  const claudeResult = await spawnSafe("claude", ["--version"], {
    timeoutMs: 5_000,
  });
  results.push({
    name: "claude CLI installed",
    ok: claudeResult.exitCode === 0,
    message:
      claudeResult.stdout.trim() || claudeResult.stderr.trim() || "not found",
  });

  // 3. Project config
  const hasConfig = configExists(projectName);
  results.push({
    name: "project config exists",
    ok: hasConfig,
    message: hasConfig
      ? `~/.jira-acp/projects/${projectName}.json`
      : `Run: jiraACP init --name ${projectName}`,
  });

  if (!hasConfig) {
    printResults(results);
    return;
  }

  try {
    const config = loadConfig(projectName);

    // 4. Jira connectivity (using tokens from config)
    try {
      await axios.get(`${config.jira.url}/rest/api/3/myself`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.jira.email}:${config.jira.token}`).toString("base64")}`,
        },
        timeout: 5_000,
      });
      results.push({
        name: "Jira connectivity",
        ok: true,
        message: `${config.jira.url} ✓`,
      });
    } catch {
      results.push({
        name: "Jira connectivity",
        ok: false,
        message: `${config.jira.url} — connection failed`,
      });
    }

    // 5. GitHub token
    results.push({
      name: "GitHub token",
      ok: Boolean(config.github.token),
      message: config.github.token
        ? "set"
        : "empty — run: jiraACP config set github.token <token>",
    });

    // 6. Telegram bot token
    results.push({
      name: "Telegram bot token",
      ok: Boolean(config.telegram.botToken),
      message: config.telegram.botToken ? "set" : "empty",
    });
  } catch (err) {
    results.push({ name: "Config load", ok: false, message: String(err) });
  }

  printResults(results);
}

function printResults(results: CheckResult[]): void {
  for (const r of results) {
    const icon = r.ok ? pc.green("✓") : pc.red("✗");
    const name = r.ok ? pc.green(r.name) : pc.red(r.name);
    console.log(`  ${icon}  ${name}  ${pc.gray(r.message)}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log();
  if (failed.length === 0) {
    console.log(pc.green("  All checks passed.\n"));
  } else {
    console.log(pc.red(`  ${failed.length} check(s) failed.\n`));
    process.exitCode = 1;
  }
}
