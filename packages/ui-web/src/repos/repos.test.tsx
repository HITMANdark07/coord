import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { App, type AppPlatform } from "../app";

// No vitest globals, so testing-library does not unmount between tests by itself.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const repo = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Repo ${id}`,
  path: `/code/${id}`,
  defaultBranch: "main",
  remoteUrl: `git@example.com:${id}.git`,
  bypassAllowed: false,
  createdAt: "2026-10-26T00:00:00.000Z",
  ...over,
});

function setup(
  repos: unknown[],
  {
    surface = "desktop",
    platform,
    onRequest = () => undefined,
  }: {
    surface?: "desktop" | "web";
    platform?: AppPlatform;
    onRequest?: (req: { method: string; path: string; body?: unknown }) => unknown;
  } = {},
) {
  const transport = fakeTransport((req) => {
    const custom = onRequest(req);
    if (custom !== undefined) return custom;
    if (req.path === "/repos") return repos;
    if (req.path === "/health") return { ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" };
    return [];
  });
  render(
    <ClientProvider client={createClient(transport)}>
      <App surface={surface} {...(platform ? { platform } : {})} />
    </ClientProvider>,
  );
  return transport;
}

const repoEvent = (r: unknown) => ({ seq: 1, at: "x", payload: { kind: "repo.updated", repo: r } }) as never;

describe("repos", () => {
  it("picks a folder on desktop and adds it", async () => {
    const added = repo("new");
    const pickFolder = vi.fn().mockResolvedValue("/code/new");
    const repos = [repo("a")];
    const transport = setup(repos, {
      platform: { pickFolder },
      onRequest: (req) => {
        if (req.method !== "POST") return undefined;
        repos.push(added);
        return added;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    await waitFor(() =>
      expect(transport.requests.find((r) => r.method === "POST")?.body).toEqual({ path: "/code/new" }),
    );
    // The daemon announces the new repo; it becomes the selected one.
    act(() => transport.emit(repoEvent(added)));
    expect(await screen.findByRole("button", { name: /Repo new ▾/ })).toBeTruthy();
  });

  it("cancelling the picker adds nothing", async () => {
    const pickFolder = vi.fn().mockResolvedValue(null);
    const transport = setup([repo("a")], { platform: { pickFolder } });
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(transport.requests.some((r) => r.method === "POST")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull(); // a cancel is not an error
  });

  it("web adds a repo by path and shows the daemon's error inline", async () => {
    const transport = setup([repo("a")], {
      surface: "web",
      onRequest: (req) => {
        if (req.method === "POST") throw new Error("not a git repository");
        return undefined;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Repo path" }), {
      target: { value: "/code/plain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("not a git repository")).toBeTruthy();
    expect(transport.requests.find((r) => r.method === "POST")?.body).toEqual({ path: "/code/plain" });
  });

  it("no repos shows the empty state", async () => {
    setup([], { surface: "web" });
    expect(await screen.findByText("Add a repo to start")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Repo path" })).toBeTruthy();
  });

  it("bypass checkbox shows only on desktop and sends updateRepo", async () => {
    const transport = setup([repo("a")], {
      onRequest: (req) => (req.method === "PATCH" ? repo("a", { bypassAllowed: true }) : undefined),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repo settings" }));
    expect(screen.getByText("/code/a")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("git@example.com:a.git")).toBeTruthy();
    expect(
      screen.getByText(
        "Bypass runs every tool call without asking. Only use it for repos you'd let the agent change freely.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow bypass mode for this repo" }));
    await waitFor(() => {
      const patch = transport.requests.find((r) => r.method === "PATCH");
      expect(patch?.path).toBe("/repos/a");
      expect(patch?.body).toEqual({ bypassAllowed: true });
    });
  });

  it("the web app never offers bypass", async () => {
    setup([repo("a")], { surface: "web" });
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repo settings" }));
    expect(screen.getByText("/code/a")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Allow bypass mode for this repo" })).toBeNull();
  });

  it("remembers the selected repo, and falls back when storage throws", async () => {
    const transport = setup([repo("a"), repo("b")]);
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repo b" }));
    expect(await screen.findByRole("button", { name: /Repo b ▾/ })).toBeTruthy();
    expect(localStorage.getItem("coord.repo")).toBe("b");
    await waitFor(() => expect(transport.requests.some((r) => r.path.includes("repoId=b"))).toBe(true));

    cleanup();
    setup([repo("a"), repo("b")]);
    expect(await screen.findByRole("button", { name: /Repo b ▾/ })).toBeTruthy();

    cleanup();
    localStorage.setItem("coord.repo", "gone");
    setup([repo("a"), repo("b")]);
    expect(await screen.findByRole("button", { name: /Repo a ▾/ })).toBeTruthy(); // unknown id

    cleanup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    setup([repo("a"), repo("b")]);
    fireEvent.click(await screen.findByRole("button", { name: /Repo a ▾/ }));
    fireEvent.click(screen.getByRole("button", { name: "Repo b" }));
    expect(await screen.findByRole("button", { name: /Repo b ▾/ })).toBeTruthy();
  });
});
