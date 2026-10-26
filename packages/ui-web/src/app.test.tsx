import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientProvider } from "@wto/app-state";
import { createClient } from "@wto/client";
import { fakeTransport } from "@wto/client/testing";
import { App } from "./app";

const transport = fakeTransport((req) =>
  req.path === "/health"
    ? { ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" }
    : [
        {
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
        },
      ],
);

describe("App", () => {
  it("shows daemon status and tasks", async () => {
    render(
      <ClientProvider client={createClient(transport)}>
        <App surface="web" />
      </ClientProvider>,
    );
    expect(await screen.findByText(/Daemon connected/)).toBeTruthy();
    expect(await screen.findByText("Add dark mode")).toBeTruthy();
  });
});
