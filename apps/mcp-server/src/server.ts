import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordClient } from "@coord/client";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** MCP tools that let Claude Code drive the orchestrator (PRD §7.2). */
export function createMcpServer(client: CoordClient) {
  const server = new McpServer({ name: "coord", version: "0.1.0" });

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
        agent: z
          .enum(["claude-code", "codex"])
          .optional()
          .describe("Which agent runs it (default claude-code)"),
        model: z.string().optional(),
        // `bypass` is deliberately not offered: only a person may turn off permission prompts.
        permissionMode: z.enum(["ask", "accept_edits"]).optional().describe("ask (default) or accept_edits"),
      },
    },
    async (input) => json(await client.createTask(input)),
  );

  server.registerTool(
    "get_task",
    { description: "Get one task by id", inputSchema: { id: z.string() } },
    async ({ id }) => json(await client.getTask(id)),
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a follow-up message to a task's agent",
      inputSchema: { id: z.string(), text: z.string().min(1) },
    },
    async ({ id, text }) => json(await client.sendMessage(id, text)),
  );

  server.registerTool(
    "get_task_diff",
    {
      description: "Get the changes a task made: changed files and the patch",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => json(await client.taskDiff(id)),
  );

  return server;
}
