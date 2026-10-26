import { describe, expect, it } from "vitest";
import { DaemonError } from "@wto/client";
import { fromIpcReply, isDaemonRequest, toIpcReply } from "./ipc";

describe("isDaemonRequest", () => {
  it("accepts normal API requests", () => {
    expect(isDaemonRequest({ method: "GET", path: "/tasks" })).toBe(true);
    expect(isDaemonRequest({ method: "POST", path: "/tasks", body: { prompt: "x" } })).toBe(true);
    expect(isDaemonRequest({ method: "GET", path: "/tasks/abc%20d?x=1" })).toBe(true);
  });

  it("rejects requests that could reach another host or are malformed", () => {
    expect(isDaemonRequest({ method: "GET", path: "@evil.com/" })).toBe(false);
    expect(isDaemonRequest({ method: "GET", path: "//evil.com/" })).toBe(false);
    expect(isDaemonRequest({ method: "GET", path: "/x@evil.com" })).toBe(false);
    expect(isDaemonRequest({ method: "TRACE", path: "/tasks" })).toBe(false);
    expect(isDaemonRequest({ method: "GET" })).toBe(false);
    expect(isDaemonRequest(null)).toBe(false);
  });
});

describe("IPC replies", () => {
  it("carries the daemon's status and code across the IPC boundary", () => {
    const reply = toIpcReply(new DaemonError(404, "not_found", "task x not found"));
    // Simulate Electron's structured clone between processes.
    const err = (() => {
      try {
        fromIpcReply(structuredClone(reply));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });

  it("passes successful bodies through", () => {
    expect(fromIpcReply({ ok: true, body: [1] })).toEqual([1]);
  });
});
