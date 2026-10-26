import { describe, expect, it } from "vitest";
import { TaskStatus } from "@coord/protocol";
import { colors, statusColors } from "./index";

describe("design tokens", () => {
  it("has a color for every task status", () => {
    for (const status of [...TaskStatus.options, "unknown" as const])
      expect(statusColors[status]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("defines the same keys in light and dark themes", () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });
});
