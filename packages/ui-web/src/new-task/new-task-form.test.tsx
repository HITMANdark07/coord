import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { NewTaskForm } from "./new-task-form";

afterEach(cleanup);

const repo = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Repo ${id}`,
  path: `/code/${id}`,
  defaultBranch: "main",
  remoteUrl: "",
  bypassAllowed: false,
  createdAt: "2026-10-26T00:00:00.000Z",
  ...over,
});
const task = {
  id: "t1",
  repoId: "a",
  repoPath: "/code/a",
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
const view = { baseBranch: "main", config: {}, setup: ["pnpm install"], setupSource: "detected" };
const agents = (codex = true) => [
  { id: "claude-code", available: true, costReporting: true, liveMessages: true },
  { id: "codex", available: codex, costReporting: false, liveMessages: false },
];

function setup({
  repos = [repo("a")],
  surface = "desktop",
  codex = true,
  onRequest = () => undefined,
}: {
  repos?: unknown[];
  surface?: "desktop" | "web";
  codex?: boolean;
  onRequest?: (req: { method: string; path: string; body?: unknown }) => unknown;
} = {}) {
  const onCreated = vi.fn();
  const transport = fakeTransport((req) => {
    const custom = onRequest(req);
    if (custom !== undefined) return custom;
    if (req.path === "/repos") return repos;
    if (req.path === "/agents") return agents(codex);
    if (req.path.endsWith("/config")) return view;
    if (req.method === "POST" && req.path === "/tasks") return task;
    return [];
  });
  render(
    <ClientProvider client={createClient(transport)}>
      <NewTaskForm repoId="a" surface={surface} onCreated={onCreated} onClose={() => {}} />
    </ClientProvider>,
  );
  const posts = () => transport.requests.filter((r) => r.method === "POST" && r.path === "/tasks");
  return { onCreated, posts, transport };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const prompt = (v: string) => type("What should the agent do?", v);

describe("NewTaskForm", () => {
  it("focuses the prompt on open and gives focus back on close", () => {
    const transport = fakeTransport(() => []);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>+ New task</button>
          {open && (
            <NewTaskForm repoId="a" surface="web" onCreated={() => {}} onClose={() => setOpen(false)} />
          )}
        </>
      );
    }
    render(
      <ClientProvider client={createClient(transport)}>
        <Harness />
      </ClientProvider>,
    );
    const opener = screen.getByRole("button", { name: "+ New task" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("What should the agent do?"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
  });

  it("shows the repo path and base branch", async () => {
    setup();
    expect(await screen.findByText("/code/a · base main")).toBeTruthy();
  });

  it("branch follows the prompt until edited", async () => {
    setup();
    const branch = screen.getByLabelText<HTMLInputElement>("Branch");
    prompt("Add CSV export");
    expect(branch.value).toBe("agent/add-csv-export");
    type("Branch", "agent/mine");
    prompt("Something else");
    expect(branch.value).toBe("agent/mine");
  });

  it("sends only the fields the user set", async () => {
    const { posts } = setup();
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    fireEvent.click(screen.getByText("Start task"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = posts()[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ repoId: "a", prompt: "Add CSV export", agent: "claude-code" });
    for (const k of ["model", "branch", "baseBranch"]) expect(body).not.toHaveProperty(k);
  });

  it("sends model, branch and base branch once changed", async () => {
    const { posts } = setup();
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    type("Model", "opus");
    type("Branch", "agent/csv");
    fireEvent.click(screen.getByText(/Advanced/));
    type("Base branch", "dev");
    fireEvent.click(screen.getByLabelText("Auto-accept edits"));
    fireEvent.click(screen.getByText("Start task"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({
      model: "opus",
      branch: "agent/csv",
      baseBranch: "dev",
      permissionMode: "accept_edits",
    });
  });

  it("codex shows as not installed when unavailable", async () => {
    setup({ codex: false });
    const codex = await screen.findByLabelText<HTMLInputElement>(/Codex/);
    await waitFor(() => expect(codex.disabled).toBe(true));
    expect(screen.getByText("Codex (not installed)")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Claude Code").checked).toBe(true);
  });

  it("bypass is offered only on desktop for an opted-in repo", async () => {
    const optedIn = [repo("a", { bypassAllowed: true })];
    for (const [surface, repos, shown] of [
      ["desktop", optedIn, true],
      ["web", optedIn, false],
      ["desktop", [repo("a")], false],
    ] as const) {
      setup({ surface, repos: [...repos] });
      await screen.findByText("/code/a · base main");
      fireEvent.click(screen.getByText(/Advanced/));
      expect(screen.queryByLabelText("Bypass") !== null).toBe(shown);
      expect(
        screen.queryByText(
          "Bypass runs every tool call without asking. Only use it for repos you'd let the agent change freely.",
        ) !== null,
      ).toBe(shown);
      cleanup();
    }
  });

  it("invalid branch shows an inline error and sends nothing", async () => {
    const { posts } = setup();
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    type("Branch", "main");
    fireEvent.click(screen.getByText("Start task"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Branch must start with agent\//);
    // Once the action settles there is still just our message, so the invalid branch never reached the client.
    await waitFor(() => expect((screen.getByText("Start task") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(posts()).toHaveLength(0);
  });

  it("Cmd+Enter submits and opens the new task", async () => {
    const { onCreated, posts } = setup();
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    fireEvent.keyDown(screen.getByLabelText("What should the agent do?"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t1"));
    expect(posts()).toHaveLength(1);
  });

  it("does not submit an empty prompt", async () => {
    const { posts } = setup();
    expect((screen.getByText("Start task") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("What should the agent do?"), { key: "Enter", ctrlKey: true });
    expect(posts()).toHaveLength(0);
  });

  it("daemon error is shown inline", async () => {
    const { onCreated } = setup({
      onRequest: (r) => {
        if (r.method === "POST") throw new Error("repo not registered");
      },
    });
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    fireEvent.click(screen.getByText("Start task"));
    expect((await screen.findByRole("alert")).textContent).toContain("repo not registered");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows a config error inline, still starts, and sends a typed base branch only", async () => {
    const { posts } = setup({
      onRequest: (r) => {
        if (r.path.endsWith("/config")) throw new Error("base branch not fetched");
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("base branch not fetched");
    prompt("Add CSV export");
    fireEvent.click(screen.getByText("Start task"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).not.toHaveProperty("baseBranch");
  });

  it("lists the setup script read-only with its source", async () => {
    setup();
    await screen.findByText("/code/a · base main");
    fireEvent.click(screen.getByText(/Advanced/));
    expect(screen.getByText("pnpm install")).toBeTruthy();
    expect(screen.getByText(/detected/)).toBeTruthy();
    expect(screen.getByText(/Change it in/)).toBeTruthy();
  });

  it("never sends a stale bypass after switching to a repo that is not opted in", async () => {
    const { posts } = setup({ repos: [repo("a", { bypassAllowed: true }), repo("b")] });
    await screen.findByText("/code/a · base main");
    fireEvent.click(screen.getByText(/Advanced/));
    fireEvent.click(screen.getByLabelText("Bypass"));
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "b" } });
    prompt("Add CSV export");
    fireEvent.click(screen.getByText("Start task"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ repoId: "b", permissionMode: "ask" });
  });

  it("never sends bypass once the repo's opt-in is revoked", async () => {
    const a = repo("a", { bypassAllowed: true });
    const repos = [a];
    const { posts, transport } = setup({ repos });
    await screen.findByText("/code/a · base main");
    fireEvent.click(screen.getByText(/Advanced/));
    fireEvent.click(screen.getByLabelText("Bypass"));
    repos[0] = { ...a, bypassAllowed: false }; // what the refetch after the event returns
    act(() =>
      transport.emit({
        seq: 1,
        at: "x",
        payload: { kind: "repo.updated", repo: { ...a, bypassAllowed: false } },
      } as never),
    );
    await waitFor(() => expect(screen.queryByLabelText("Bypass")).toBeNull());
    prompt("Add CSV export");
    fireEvent.click(screen.getByText("Start task"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ permissionMode: "ask" });
  });

  it("a cleared branch follows the prompt again", async () => {
    setup();
    const branch = screen.getByLabelText<HTMLInputElement>("Branch");
    type("Branch", "agent/mine");
    type("Branch", "");
    prompt("Add CSV export");
    expect(branch.value).toBe("agent/add-csv-export");
  });

  it("plain Enter in a single-line input does not start a task", async () => {
    const { posts } = setup();
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    // jsdom has no implicit submission, so assert its trigger: the keydown default is prevented.
    expect(fireEvent.keyDown(screen.getByLabelText("Model"), { key: "Enter" })).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it("a failed create keeps the prompt", async () => {
    setup({
      onRequest: (r) => {
        if (r.method === "POST") throw new Error("boom");
      },
    });
    await screen.findByText("/code/a · base main");
    prompt("Add CSV export");
    fireEvent.click(screen.getByText("Start task"));
    await screen.findByText("boom");
    expect(screen.getByLabelText<HTMLTextAreaElement>("What should the agent do?").value).toBe(
      "Add CSV export",
    );
  });
});
