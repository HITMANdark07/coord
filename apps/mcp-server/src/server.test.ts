import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { createMcpServer } from "./server";

describe("coord MCP server", () => {
  it("exposes the task tools to an MCP client", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(createClient(fakeTransport(() => []))).connect(serverSide);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(clientSide);

    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_task", "get_task", "list_tasks"]);

    const result = await mcp.callTool({ name: "list_tasks", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "[]" }]);
    await mcp.close();
  });

  it("creates tasks for absolute repo paths and rejects relative ones before calling the daemon", async () => {
    const task = {
      id: "t1",
      repoPath: "/abs/repo",
      title: "x",
      prompt: "x",
      agent: "claude-code",
      status: "queued",
      branch: null,
      worktreePath: null,
      sessionId: null,
      costUsd: 0,
      createdAt: "2026-10-26T00:00:00.000Z",
    };
    const transport = fakeTransport(() => task);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(createClient(transport)).connect(serverSide);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(clientSide);

    const relative = await mcp.callTool({
      name: "create_task",
      arguments: { repoPath: "repo", prompt: "x" },
    });
    expect(relative.isError).toBe(true);
    expect(transport.requests).toHaveLength(0);

    const absolute = await mcp.callTool({
      name: "create_task",
      arguments: { repoPath: "/abs/repo", prompt: "x" },
    });
    expect(absolute.isError).toBeFalsy();
    expect(transport.requests).toHaveLength(1);
    await mcp.close();
  });
});
