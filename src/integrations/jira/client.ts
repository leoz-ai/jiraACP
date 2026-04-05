import axios, { type AxiosInstance } from "axios";

export interface JiraConfig {
  url: string;
  token: string;
  email: string;
}

// Auto-discover instances from env vars: JIRA_{NAME}_URL, JIRA_{NAME}_TOKEN, JIRA_{NAME}_EMAIL
function loadInstances(): Record<string, JiraConfig> {
  const instances: Record<string, JiraConfig> = {};

  for (const key of Object.keys(process.env)) {
    const match = key.match(/^JIRA_([A-Z0-9]+)_URL$/);
    if (!match) continue;

    const name = match[1].toLowerCase();
    const upper = match[1];
    const url = process.env[`JIRA_${upper}_URL`];
    const token = process.env[`JIRA_${upper}_TOKEN`];
    const email = process.env[`JIRA_${upper}_EMAIL`];

    if (url && token && email) {
      instances[name] = { url, token, email };
    }
  }

  return instances;
}

export const INSTANCES = loadInstances();

export type JiraClient = AxiosInstance;

export function getClient(instance: string): JiraClient {
  const config = INSTANCES[instance];
  if (!config) {
    const available = Object.keys(INSTANCES).join(", ") || "none";
    throw new Error(
      `Unknown Jira instance: "${instance}". Available: ${available}`,
    );
  }

  return axios.create({
    baseURL: `${config.url}/rest/api/3`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}
