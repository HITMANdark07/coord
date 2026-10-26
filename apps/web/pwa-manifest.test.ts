import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pwaManifest } from "./pwa-manifest";

describe("PWA manifest", () => {
  it("meets the browsers' installability requirements", () => {
    expect(pwaManifest.name).toBeTruthy();
    expect(pwaManifest.short_name).toBeTruthy();
    expect(pwaManifest.start_url).toBe("/");
    expect(["standalone", "fullscreen"]).toContain(pwaManifest.display);
    const sizes = pwaManifest.icons?.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(pwaManifest.icons?.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("only lists icon files that exist", () => {
    for (const icon of pwaManifest.icons ?? []) {
      expect(existsSync(join(import.meta.dirname, "public", icon.src)), icon.src).toBe(true);
    }
  });
});
