import { z } from "zod";
import { getClient } from "./client.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const instanceSchema = z.string().describe('Instance name (e.g. "hi", "geo")');

export const GetTasksSchema = z.object({
  instance: instanceSchema,
  assignees: z
    .array(z.string())
    .describe("List of Jira usernames or accountIds"),
  project_key: z
    .string()
    .optional()
    .describe('Filter by project key (e.g. "HI")'),
  status: z
    .string()
    .optional()
    .describe('Filter by status (e.g. "In Progress")'),
  max_results: z.number().default(20),
});

export const GetTicketSchema = z.object({
  instance: instanceSchema,
  ticket_key: z.string().describe('Jira ticket key (e.g. "HI-123")'),
});

export const GetTransitionsSchema = z.object({
  instance: instanceSchema,
  ticket_key: z.string(),
});

export const TransitionTicketSchema = z.object({
  instance: instanceSchema,
  ticket_key: z.string(),
  transition_name: z
    .string()
    .describe('Transition name (e.g. "In Review", "Done")'),
});

export const AddCommentSchema = z.object({
  instance: instanceSchema,
  ticket_key: z.string(),
  comment: z.string().describe("Comment text (plain text or Jira markdown)"),
});

export const ReassignSchema = z.object({
  instance: instanceSchema,
  ticket_key: z.string(),
  account_id: z.string().describe("Jira accountId of the new assignee"),
});

// ─── Tool implementations ────────────────────────────────────────────────────

export async function getTasks(
  args: z.infer<typeof GetTasksSchema>,
): Promise<string> {
  const client = getClient(args.instance);

  const conditions = [
    args.assignees.map((a) => `assignee = "${a}"`).join(" OR "),
    args.project_key ? `project = ${args.project_key}` : null,
    args.status ? `status = "${args.status}"` : null,
  ].filter(Boolean);

  const jql = conditions.join(" AND ") + " ORDER BY updated DESC";

  const { data } = await client.get("/search", {
    params: {
      jql,
      maxResults: args.max_results,
      fields: "summary,status,assignee,priority,description,created,updated",
    },
  });

  const issues = data.issues.map((issue: JiraIssue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? "Unassigned",
    priority: issue.fields.priority?.name ?? "None",
  }));

  return JSON.stringify({ total: data.total, issues }, null, 2);
}

export async function getTicket(
  args: z.infer<typeof GetTicketSchema>,
): Promise<string> {
  const client = getClient(args.instance);
  const { data } = await client.get(`/issue/${args.ticket_key}`);

  return JSON.stringify(
    {
      key: data.key,
      summary: data.fields.summary,
      status: data.fields.status.name,
      assignee: data.fields.assignee?.displayName ?? "Unassigned",
      priority: data.fields.priority?.name,
      description: extractText(data.fields.description),
      acceptance_criteria: extractText(data.fields.customfield_10016),
      created: data.fields.created,
      updated: data.fields.updated,
    },
    null,
    2,
  );
}

export async function getTransitions(
  args: z.infer<typeof GetTransitionsSchema>,
): Promise<string> {
  const client = getClient(args.instance);
  const { data } = await client.get(`/issue/${args.ticket_key}/transitions`);
  const transitions = data.transitions.map((t: JiraTransition) => ({
    id: t.id,
    name: t.name,
  }));
  return JSON.stringify(transitions, null, 2);
}

export async function transitionTicket(
  args: z.infer<typeof TransitionTicketSchema>,
): Promise<string> {
  const client = getClient(args.instance);

  const { data } = await client.get(`/issue/${args.ticket_key}/transitions`);
  const transition = data.transitions.find(
    (t: JiraTransition) =>
      t.name.toLowerCase() === args.transition_name.toLowerCase(),
  );

  if (!transition) {
    const available = data.transitions
      .map((t: JiraTransition) => t.name)
      .join(", ");
    throw new Error(
      `Transition "${args.transition_name}" not found. Available: ${available}`,
    );
  }

  await client.post(`/issue/${args.ticket_key}/transitions`, {
    transition: { id: transition.id },
  });
  return `Transitioned ${args.ticket_key} to "${transition.name}"`;
}

export async function addComment(
  args: z.infer<typeof AddCommentSchema>,
): Promise<string> {
  const client = getClient(args.instance);

  await client.post(`/issue/${args.ticket_key}/comment`, {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: args.comment }] },
      ],
    },
  });

  return `Comment added to ${args.ticket_key}`;
}

export async function reassign(
  args: z.infer<typeof ReassignSchema>,
): Promise<string> {
  const client = getClient(args.instance);
  await client.put(`/issue/${args.ticket_key}/assignee`, {
    accountId: args.account_id,
  });
  return `${args.ticket_key} reassigned to accountId: ${args.account_id}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractText(adfNode: AdfNode | null | undefined): string {
  if (!adfNode) return "";
  if (typeof adfNode === "string") return adfNode;
  if (adfNode.type === "text") return adfNode.text ?? "";
  if (adfNode.content) return adfNode.content.map(extractText).join(" ");
  return "";
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string } | null;
    priority: { name: string } | null;
    description: AdfNode | null;
    customfield_10016: AdfNode | null;
    created: string;
    updated: string;
  };
}

interface JiraTransition {
  id: string;
  name: string;
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}
