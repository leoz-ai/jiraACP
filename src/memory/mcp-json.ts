import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config/schema.js";

export async function writeMcpJson(
  projectDir: string,
  config: ProjectConfig,
  instanceName: string,
): Promise<void> {
  const upper = instanceName.toUpperCase();
  const claudeDir = path.join(projectDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const mcpJson = {
    mcpServers: {
      jira: {
        command: "jiraACP-mcp",
        env: {
          [`JIRA_${upper}_URL`]: `env:JIRA_${upper}_URL`,
          [`JIRA_${upper}_TOKEN`]: `env:JIRA_${upper}_TOKEN`,
          [`JIRA_${upper}_EMAIL`]: `env:JIRA_${upper}_EMAIL`,
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(claudeDir, ".mcp.json"),
    JSON.stringify(mcpJson, null, 2),
  );
}
