import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { INSTANCES } from "./integrations/jira/client.js";
import {
  GetTasksSchema,
  GetTicketSchema,
  GetTransitionsSchema,
  TransitionTicketSchema,
  AddCommentSchema,
  ReassignSchema,
  getTasks,
  getTicket,
  getTransitions,
  transitionTicket,
  addComment,
  reassign,
} from "./integrations/jira/tools.js";

const server = new Server(
  { name: "jiraACP-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "jira_get_tasks",
      description: "Get Jira tasks assigned to specific users.",
      inputSchema: {
        type: "object",
        properties: GetTasksSchema.shape,
        required: ["instance", "assignees"],
      },
    },
    {
      name: "jira_get_ticket",
      description: "Get full details of a single Jira ticket.",
      inputSchema: {
        type: "object",
        properties: GetTicketSchema.shape,
        required: ["instance", "ticket_key"],
      },
    },
    {
      name: "jira_get_transitions",
      description: "Get available status transitions for a ticket.",
      inputSchema: {
        type: "object",
        properties: GetTransitionsSchema.shape,
        required: ["instance", "ticket_key"],
      },
    },
    {
      name: "jira_transition_ticket",
      description: "Change the status of a Jira ticket.",
      inputSchema: {
        type: "object",
        properties: TransitionTicketSchema.shape,
        required: ["instance", "ticket_key", "transition_name"],
      },
    },
    {
      name: "jira_add_comment",
      description: "Add a comment to a Jira ticket.",
      inputSchema: {
        type: "object",
        properties: AddCommentSchema.shape,
        required: ["instance", "ticket_key", "comment"],
      },
    },
    {
      name: "jira_reassign",
      description: "Reassign a Jira ticket to another user by accountId.",
      inputSchema: {
        type: "object",
        properties: ReassignSchema.shape,
        required: ["instance", "ticket_key", "account_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result: string;
    switch (name) {
      case "jira_get_tasks":
        result = await getTasks(GetTasksSchema.parse(args));
        break;
      case "jira_get_ticket":
        result = await getTicket(GetTicketSchema.parse(args));
        break;
      case "jira_get_transitions":
        result = await getTransitions(GetTransitionsSchema.parse(args));
        break;
      case "jira_transition_ticket":
        result = await transitionTicket(TransitionTicketSchema.parse(args));
        break;
      case "jira_add_comment":
        result = await addComment(AddCommentSchema.parse(args));
        break;
      case "jira_reassign":
        result = await reassign(ReassignSchema.parse(args));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const instanceList = Object.keys(INSTANCES);
if (instanceList.length === 0) {
  console.error(
    "No Jira instances configured. Add JIRA_{NAME}_URL/TOKEN/EMAIL to env.",
  );
  process.exit(1);
}

console.error(`jiraACP-mcp started. Instances: ${instanceList.join(", ")}`);
const transport = new StdioServerTransport();
await server.connect(transport);
