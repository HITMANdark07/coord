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
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_task",
      "get_task",
      "get_task_diff",
      "list_tasks",
      "send_message",
    ]);

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

  async function connect(transport: ReturnType<typeof fakeTransport>) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(createClient(transport)).connect(serverSide);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(clientSide);
    return mcp;
  }

  it("create_task accepts agent and refuses bypass", async () => {
    const transport = fakeTransport(() => ({
      id: "t1",
      repoPath: "/abs/repo",
      title: "x",
      prompt: "x",
      agent: "codex",
      status: "queued",
      branch: null,
      worktreePath: null,
      sessionId: null,
      costUsd: 0,
      createdAt: "2026-10-26T00:00:00.000Z",
    }));
    const mcp = await connect(transport);

    const bypass = await mcp.callTool({
      name: "create_task",
      arguments: { repoPath: "/abs/repo", prompt: "x", permissionMode: "bypass" },
    });
    expect(bypass.isError).toBe(true);
    expect(transport.requests).toHaveLength(0);

    const ok = await mcp.callTool({
      name: "create_task",
      arguments: {
        repoPath: "/abs/repo",
        prompt: "x",
        agent: "codex",
        model: "m1",
        permissionMode: "accept_edits",
      },
    });
    expect(ok.isError).toBeFalsy();
    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      path: "/tasks",
      body: { agent: "codex", model: "m1", permissionMode: "accept_edits" },
    });
    await mcp.close();
  });

  it("send_message and get_task_diff call the daemon", async () => {
    const transport = fakeTransport((req) =>
      req.path.endsWith("/diff")
        ? { baseRef: "main", files: [], patch: "P", truncated: false }
        : {
            id: "t1",
            repoPath: "/abs/repo",
            title: "x",
            prompt: "x",
            agent: "claude-code",
            status: "running",
            branch: null,
            worktreePath: null,
            sessionId: null,
            costUsd: 0,
            createdAt: "2026-10-26T00:00:00.000Z",
          },
    );
    const mcp = await connect(transport);
    const sent = await mcp.callTool({ name: "send_message", arguments: { id: "t1", text: "go on" } });
    expect(sent.isError).toBeFalsy();
    expect(transport.requests[0]).toMatchObject({ path: "/tasks/t1/messages", body: { text: "go on" } });
    const diff = await mcp.callTool({ name: "get_task_diff", arguments: { id: "t1" } });
    expect(JSON.stringify(diff.content)).toContain('\\"patch\\": \\"P\\"');
    await mcp.close();
  });
});
