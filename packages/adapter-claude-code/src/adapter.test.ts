import type {
  CanUseTool,
  Options,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { AgentEvent, PermissionRequest, RunContext } from "@coord/protocol";
import { buildOptions, CLAUDE_SETTING_SOURCES, createClaudeCodeAdapter, permissionBridge } from "./adapter";
import { toAgentEvents } from "./events";

// Fixtures carry only the fields the adapter reads; the SDK types are much larger.
const fixtures = [
  { type: "system", subtype: "init", session_id: "s-1" },
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Adding dark mode." },
        { type: "tool_use", id: "tu-1", name: "Edit", input: { file_path: "a.ts" } },
      ],
    },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    total_cost_usd: 0.12,
    usage: { input_tokens: 100, output_tokens: 20 },
  },
] as unknown as SDKMessage[];

interface Seen {
  options?: Options;
  prompts: string[];
  interrupted: boolean;
}

/** Stands in for the SDK: records options and streamed user messages, replays fixtures per message. */
function fakeQuery(seen: Seen) {
  return (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    seen.options = options;
    const session = (async function* () {
      for await (const msg of prompt) {
        seen.prompts.push(String(msg.message.content));
        yield* fixtures;
      }
    })();
    return Object.assign(session, {
      interrupt: async () => {
        seen.interrupted = true;
        return undefined;
      },
    });
  }) as unknown as typeof query;
}

const newSeen = (): Seen => ({ prompts: [], interrupted: false });

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  cwd: "/worktrees/dark-mode",
  signal: new AbortController().signal,
  requestPermission: async () => ({ allow: true }) as const,
  ...overrides,
});

/** Reads `count` events, then ends the session input so the run can finish. */
async function take(run: { events: AsyncIterable<AgentEvent>; end(): void }, count: number) {
  const out: AgentEvent[] = [];
  for await (const e of run.events) {
    out.push(e);
    if (out.length === count) run.end();
  }
  return out;
}

const permissionOptions = (extra: Partial<Parameters<CanUseTool>[2]> = {}) =>
  ({ signal: new AbortController().signal, toolUseID: "tu-9", ...extra }) as Parameters<CanUseTool>[2];

describe("Claude Code adapter", () => {
  it("maps SDK messages to agent events", async () => {
    const run = createClaudeCodeAdapter({ query: fakeQuery(newSeen()) }).start(
      { taskId: "t1", prompt: "Add dark mode" },
      ctx(),
    );
    expect(await take(run, 6)).toEqual([
      { type: "session", sessionId: "s-1" },
      { type: "text", text: "Adding dark mode." },
      { type: "tool_call", toolUseId: "tu-1", name: "Edit", input: { file_path: "a.ts" } },
      { type: "tool_result", toolUseId: "tu-1", ok: true },
      { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.12 },
      { type: "done", summary: "Done" },
    ]);
  });

  it("delivers follow-up messages into the running session", async () => {
    const seen = newSeen();
    const run = createClaudeCodeAdapter({ query: fakeQuery(seen) }).start(
      { taskId: "t1", prompt: "first" },
      ctx(),
    );
    run.send("also add tests");
    await take(run, 12);
    expect(seen.prompts).toEqual(["first", "also add tests"]);
  });

  it("interrupts the SDK session", async () => {
    const seen = newSeen();
    const run = createClaudeCodeAdapter({ query: fakeQuery(seen) }).start(
      { taskId: "t1", prompt: "x" },
      ctx(),
    );
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    await run.interrupt();
    expect(seen.interrupted).toBe(true);
    run.end();
  });

  it("resumes a session by id", async () => {
    const seen = newSeen();
    await take(createClaudeCodeAdapter({ query: fakeQuery(seen) }).resume("s-1", "continue", ctx()), 6);
    expect(seen.options?.resume).toBe("s-1");
  });

  it("ends with an error event when aborted before it started", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = createClaudeCodeAdapter({ query: fakeQuery(newSeen()) }).start(
      { taskId: "t1", prompt: "x" },
      ctx({ signal: controller.signal }),
    );
    expect(await take(run, 1)).toEqual([{ type: "error", message: "run aborted before it started" }]);
  });
});

describe("Claude Code adapter failure paths", () => {
  it("ends with an error event when aborted mid-run instead of throwing", async () => {
    const controller = new AbortController();
    // Like the SDK: the session throws once its abort controller fires.
    const throwingQuery = (({ options }: { options?: Options }) =>
      Object.assign(
        (async function* () {
          yield fixtures[0];
          await new Promise((_resolve, reject) => {
            const signal = options?.abortController?.signal;
            const fail = () => reject(new Error("Claude Code process aborted by user"));
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail);
          });
        })(),
        { interrupt: async () => undefined },
      )) as unknown as typeof query;
    const run = createClaudeCodeAdapter({ query: throwingQuery }).start(
      { taskId: "t1", prompt: "x" },
      ctx({ signal: controller.signal }),
    );
    const events: AgentEvent[] = [];
    for await (const e of run.events) {
      events.push(e);
      if (e.type === "session") controller.abort();
    }
    expect(events).toEqual([
      { type: "session", sessionId: "s-1" },
      { type: "error", message: "run aborted" },
    ]);
  });

  it("refuses messages after the session ended without throwing", async () => {
    const run = createClaudeCodeAdapter({ query: fakeQuery(newSeen()) }).start(
      { taskId: "t1", prompt: "x" },
      ctx(),
    );
    await take(run, 6);
    expect(run.send("too late")).toBe(false);
  });
});

describe("buildOptions", () => {
  it("never lets caller options override the worktree, setup or permissions", () => {
    const hostile = {
      cwd: "/",
      settingSources: [],
      canUseTool: async () => ({ behavior: "allow" as const }),
      model: "claude-opus-5-5",
    } satisfies Partial<Options>;
    const options = buildOptions(hostile, ctx(), new AbortController());
    expect(options.cwd).toBe("/worktrees/dark-mode");
    expect(options.settingSources).toEqual(CLAUDE_SETTING_SOURCES);
    expect(options.settingSources).toContain("project");
    expect(options.canUseTool).not.toBe(hostile.canUseTool);
    expect(options.model).toBe("claude-opus-5-5");
  });
});

describe("permissionBridge", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
  ] as PermissionUpdate[];

  it("forwards the tool use id, title and whether it can be remembered", async () => {
    let asked: PermissionRequest | undefined;
    const bridge = permissionBridge(
      ctx({
        requestPermission: async (request) => {
          asked = request;
          return { allow: false, reason: "not on main" };
        },
      }),
    );
    const result = await bridge(
      "Bash",
      { command: "git push" },
      permissionOptions({ title: "Run git push", suggestions }),
    );
    expect(result).toEqual({ behavior: "deny", message: "not on main" });
    expect(asked).toEqual({
      toolUseId: "tu-9",
      tool: "Bash",
      input: { command: "git push" },
      title: "Run git push",
      canRemember: true,
    });
  });

  it("applies 'always allow' and edited input", async () => {
    const bridge = permissionBridge(
      ctx({
        requestPermission: async () => ({ allow: true, remember: true, updatedInput: { answer: "yes" } }),
      }),
    );
    expect(await bridge("AskUserQuestion", { q: "?" }, permissionOptions({ suggestions }))).toEqual({
      behavior: "allow",
      updatedInput: { answer: "yes" },
      updatedPermissions: suggestions,
    });
  });

  it("refuses to remember when the agent forbids a permanent rule", async () => {
    const bridge = permissionBridge(
      ctx({ requestPermission: async () => ({ allow: true, remember: true }) }),
    );
    const result = await bridge(
      "Bash",
      {},
      permissionOptions({ suggestions, suppressAlwaysAllowRule: true }),
    );
    expect(result).not.toHaveProperty("updatedPermissions");
  });
});

describe("toAgentEvents", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };

  it("reports a 'success' result flagged is_error as an error", () => {
    const events = toAgentEvents({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "authentication_failed",
      total_cost_usd: 0,
      usage,
    } as unknown as SDKMessage);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("authentication_failed"),
    });
  });

  it("includes the SDK's error list for error results", () => {
    const events = toAgentEvents({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: ["hit max turns"],
      total_cost_usd: 0,
      usage,
    } as unknown as SDKMessage);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("hit max turns") });
  });
});

describe("Task 2 adapter upgrades", () => {
  const modelUsage = {
    a: {
      inputTokens: 10,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 1,
      outputTokens: 3,
      costUSD: 0.5,
    },
    b: {
      inputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 1,
      costUSD: 0.25,
    },
  };

  it("maps permission modes", () => {
    const options = buildOptions({ permissionMode: "accept_edits" }, ctx(), new AbortController());
    expect(options.permissionMode).toBe("acceptEdits");
  });

  it("passes task env through", () => {
    const options = buildOptions({ env: { COORD_PORT_BASE: "41000" } }, ctx(), new AbortController());
    expect(options.env?.COORD_PORT_BASE).toBe("41000");
  });

  it("a user interrupt ends the turn instead of failing it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const interruptQuery = (() =>
      Object.assign(
        (async function* () {
          yield fixtures[0];
          await gate;
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: [],
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          } as unknown as SDKMessage;
        })(),
        { interrupt: async () => release() },
      )) as unknown as typeof query;
    const run = createClaudeCodeAdapter({ query: interruptQuery }).start(
      { taskId: "t1", prompt: "x" },
      ctx(),
    );
    const out: AgentEvent[] = [];
    for await (const e of run.events) {
      out.push(e);
      if (out.length === 1) await run.interrupt();
      if (e.type === "done" || e.type === "error") run.end();
    }
    expect(out.at(-1)).toEqual({ type: "done", summary: "Interrupted by user" });
  });

  it("remember stays in the session", async () => {
    const bridge = permissionBridge(
      ctx({ requestPermission: async () => ({ allow: true, remember: true }) }),
    );
    const result = await bridge(
      "Bash",
      {},
      permissionOptions({
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash" }],
            behavior: "allow",
            destination: "projectSettings",
          },
        ] as PermissionUpdate[],
      }),
    );
    expect(result).toMatchObject({ updatedPermissions: [{ destination: "session" }] });
  });

  it("cost comes from modelUsage including cache tokens", () => {
    const events = toAgentEvents({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: 99,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage,
    } as unknown as SDKMessage);
    expect(events[0]).toEqual({ type: "usage", inputTokens: 17, outputTokens: 4, costUsd: 0.75 });
  });

  it("subagent output is nested", () => {
    const events = toAgentEvents({
      type: "assistant",
      parent_tool_use_id: "tu-1",
      message: { content: [{ type: "text", text: "sub" }] },
    } as unknown as SDKMessage);
    expect(events).toEqual([{ type: "text", text: "sub", parentToolUseId: "tu-1" }]);
  });
});
