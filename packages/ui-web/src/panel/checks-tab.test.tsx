import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { Task } from "@coord/protocol";
import { ChecksTab } from "./checks-tab";

afterEach(cleanup);

function setup(status: string) {
  const transport = fakeTransport(() => ({}));
  // TaskPanel holds the draft in the app.
  function Harness() {
    const [feedback, setFeedback] = useState<string | null>(null);
    return <ChecksTab task={{ id: "t", status } as Task} feedback={feedback} onFeedback={setFeedback} />;
  }
  render(
    <ClientProvider client={createClient(transport)}>
      <Harness />
    </ClientProvider>,
  );
  return () => transport.requests.filter((r) => r.method === "POST");
}

describe("ChecksTab", () => {
  it("explains that checks are not set up yet", () => {
    setup("review");
    expect(screen.getByText("Checks run here once they're set up (coming next)")).toBeTruthy();
    expect(screen.queryByText("Open PR")).toBeNull();
  });

  it("send back posts the feedback", async () => {
    const posts = setup("review");
    fireEvent.click(screen.getByRole("button", { name: "Send back with feedback…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback" }), {
      target: { value: "Also handle logout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/tasks/t/messages", body: { text: "Also handle logout" } });
  });

  it("discard asks first, then calls discard", async () => {
    const posts = setup("failed");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      screen.getByText("Discard this task? The worktree is removed; its branch is kept for 14 days."),
    ).toBeTruthy();
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" })); // the confirm button
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.path).toBe("/tasks/t/discard");
  });

  it("no review actions while running", () => {
    setup("running");
    expect(screen.queryByRole("button", { name: "Send back with feedback…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});
