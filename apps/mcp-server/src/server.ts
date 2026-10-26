import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WtoClient } from "@wto/client";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** MCP tools that let Claude Code drive the orchestrator (PRD §7.2). */
export function createMcpServer(client: WtoClient) {
  const server = new McpServer({ name: "wto", version: "0.1.0" });

  server.registerTool(
    "list_tasks",
    { description: "List all orchestrator tasks with their status" },
    async () => json(await client.listTasks()),
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task that runs a coding agent in its own git worktree",
      inputSchema: {
        repoPath: z.string().describe("Absolute path of the git repository"),
        prompt: z.string().describe("What the agent should build or fix"),
        title: z.string().optional(),
      },
    },
    async (input) => json(await client.createTask(input)),
  );

  server.registerTool(
    "get_task",
    { description: "Get one task by id", inputSchema: { id: z.string() } },
    async ({ id }) => json(await client.getTask(id)),
  );

  return server;
}
