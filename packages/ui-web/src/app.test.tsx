import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { App } from "./app";
import { ErrorBoundary } from "./error-boundary";

// No vitest globals, so testing-library does not unmount between tests by itself.
afterEach(cleanup);

const task = {
  id: "t1",
  repoPath: "/repo",
  title: "Add dark mode",
  prompt: "Add dark mode",
  agent: "claude-code",
  status: "running",
  branch: "agent/add-dark-mode",
  worktreePath: "/wt",
  sessionId: null,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
};

const renderApp = (health: () => unknown) =>
  render(
    <ClientProvider
      client={createClient(
        fakeTransport((req) =>
          req.path === "/health"
            ? health()
            : req.path === "/repos"
              ? [
                  {
                    id: "r",
                    name: "repo",
                    path: "/repo",
                    defaultBranch: "main",
                    remoteUrl: null,
                    createdAt: "x",
                  },
                ]
              : req.path === "/tasks/t1"
                ? task
                : req.path === "/agents" || !req.path.startsWith("/tasks?")
                  ? []
                  : [task],
        ),
      )}
    >
      <App surface="web" />
    </ClientProvider>,
  );

describe("App", () => {
  it("shows daemon status and tasks", async () => {
    renderApp(() => ({ ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" }));
    expect(await screen.findByText(/Daemon connected/)).toBeTruthy();
    expect(await screen.findByText("Add dark mode")).toBeTruthy();
  });

  it("daemon unreachable shows the banner and the board stays usable", async () => {
    renderApp(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await screen.findByText(/Daemon unreachable/)).toBeTruthy();
    expect(await screen.findByText("Add dark mode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New task" })).toBeTruthy();
  });
});

describe("App task panel", () => {
  it("clicking a card opens its panel next to the board, and × closes it", async () => {
    renderApp(() => ({ ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" }));
    fireEvent.click(await screen.findByRole("button", { name: /Add dark mode/ }));
    expect(await screen.findByRole("heading", { name: "Add dark mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New task" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Add dark mode" })).toBeNull();
  });
});

describe("ErrorBoundary", () => {
  it("a render error shows the recoverable error screen", () => {
    let broken = true;
    const Bomb = () => {
      if (broken) throw new Error("kaboom");
      return <p>recovered</p>;
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("recovered")).toBeTruthy();
  });
});
