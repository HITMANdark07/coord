import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient, DaemonError } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { Task } from "@coord/protocol";
import { DiffTab } from "./diff-tab";

afterEach(cleanup);

const task = { id: "t", worktreePath: "/wt/t" } as Task;
// The client drops pushed events that are not valid, so the event carries a complete task.
const fullTask = {
  id: "t",
  repoPath: "/repo",
  title: "T",
  prompt: "p",
  agent: "codex",
  status: "running",
  branch: "agent/t",
  worktreePath: "/wt/t",
  sessionId: "s",
  turns: 3,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
};

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 1..2 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

const view = (over: Record<string, unknown> = {}) => ({
  baseRef: "main",
  files: [
    { path: "a.ts", status: "modified", additions: 1, deletions: 1 },
    { path: "logo.png", status: "added", additions: 0, deletions: 0 },
  ],
  patch,
  truncated: false,
  ...over,
});

function setup(respond: () => unknown) {
  const transport = fakeTransport((req) => {
    if (req.path === "/tasks/t/diff") return respond();
    return [];
  });
  render(
    <ClientProvider client={createClient(transport)}>
      <DiffTab task={task} />
    </ClientProvider>,
  );
  return transport;
}

describe("DiffTab", () => {
  it("shows files, counts and colored lines", async () => {
    setup(() => view());
    expect(await screen.findByText("2 files · +1 −1 · base main")).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("modified")).toBeTruthy();
    const added = screen.getByText("+new");
    const removed = screen.getByText("-old");
    expect(added.style.color).toBeTruthy();
    expect(removed.style.color).toBeTruthy();
    expect(added.style.color).not.toBe(removed.style.color);
    expect(screen.getByText("@@ -1,2 +1,2 @@").style.color).not.toBe(added.style.color);
    expect(screen.getByText("Binary file changed")).toBeTruthy();
  });

  it("renders patch lines as text, not HTML", async () => {
    setup(() =>
      view({
        files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
        patch: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+<img src=x onerror=alert(1)>‮",
      }),
    );
    expect(await screen.findByText("+<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("truncated diff shows the notice", async () => {
    setup(() => view({ truncated: true }));
    expect(await screen.findByText(/Diff truncated — open the worktree to see everything/)).toBeTruthy();
    expect(screen.getByText(/\/wt\/t/)).toBeTruthy();
  });

  it("says so when nothing changed", async () => {
    setup(() => view({ files: [], patch: "" }));
    expect(await screen.findByText("No changes yet")).toBeTruthy();
  });

  it("409 shows the daemon message", async () => {
    setup(() => {
      throw new DaemonError(409, "conflict", "Task has no worktree on disk");
    });
    expect(await screen.findByText(/Task has no worktree on disk/)).toBeTruthy();
  });

  it("reloads when the task is updated", async () => {
    let n = 0;
    const transport = setup(() => view({ baseRef: `main${++n}` }));
    await screen.findByText(/base main1/);
    act(() =>
      transport.emit({
        seq: 1,
        at: "x",
        payload: { kind: "task.updated", task: fullTask },
      } as never),
    );
    await waitFor(() => expect(screen.getByText(/base main2/)).toBeTruthy());
  });
});
