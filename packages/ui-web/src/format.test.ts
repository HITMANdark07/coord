import { describe, expect, it } from "vitest";
import type { Task } from "@coord/protocol";
import { formatElapsed, formatUsage } from "./format";

const from = "2026-10-26T00:00:00.000Z";
const after = (ms: number) => new Date(Date.parse(from) + ms);

describe("formatElapsed", () => {
  it("picks seconds, minutes, hours or days", () => {
    expect(formatElapsed(from, after(45_000))).toBe("45 s");
    expect(formatElapsed(from, after(4 * 60_000 + 20_000))).toBe("4 min");
    expect(formatElapsed(from, after(2 * 3_600_000 + 60_000))).toBe("2 h");
    expect(formatElapsed(from, after(3 * 86_400_000 + 3_600_000)).toString()).toBe("3 d");
  });

  it("accepts an ISO string as the end, and never goes negative", () => {
    expect(formatElapsed(from, after(60_000).toISOString())).toBe("1 min");
    expect(formatElapsed(from, after(-5_000))).toBe("0 s");
  });
});

describe("formatUsage", () => {
  const usage = (t: Partial<Task>) => t as Task;
  it("shows dollars when the agent reports cost", () => {
    expect(formatUsage(usage({ costUsd: 0.214 }), true)).toBe("$0.21");
  });
  it("shows tokens otherwise, rounded to thousands", () => {
    expect(formatUsage(usage({ inputTokens: 30_000, outputTokens: 11_400 }), false)).toBe("41k tok");
    expect(formatUsage(usage({ inputTokens: 30_000, outputTokens: 11_600 }), false)).toBe("42k tok");
    expect(formatUsage(usage({ inputTokens: 800, outputTokens: 50 }), false)).toBe("850 tok");
  });
});
