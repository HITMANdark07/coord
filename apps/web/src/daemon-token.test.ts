// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { takeDaemonToken } from "./daemon-token";

describe("takeDaemonToken", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("takes the token from the link, keeps it for the tab, and clears it from the URL", () => {
    window.history.replaceState(null, "", "/tasks?view=all#token=abc123");
    expect(takeDaemonToken(window.location, window.history, sessionStorage)).toBe("abc123");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe("/tasks?view=all");
    // A reload in the same tab still has it.
    expect(takeDaemonToken(window.location, window.history, sessionStorage)).toBe("abc123");
  });

  it("returns nothing when the app was opened without the link", () => {
    expect(takeDaemonToken(window.location, window.history, sessionStorage)).toBeUndefined();
  });
});
