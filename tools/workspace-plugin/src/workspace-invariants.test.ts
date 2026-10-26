import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Repo-wide rules that no single package's tests can see. See AGENTS.md.
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const projects = ["apps", "packages", "tools"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .map((name) => `${dir}/${name}`)
    .filter((path) => existsSync(join(root, path, "package.json")))
    .map((path) => ({ path, manifest: JSON.parse(read(`${path}/package.json`)) })),
);

const TYPES = ["contract", "lib", "state", "ui", "adapter", "service", "daemon", "app", "tooling", "config"];
const PLATFORMS = ["any", "node", "react", "dom", "react-native", "electron"];

describe("workspace invariants", () => {
  it("pins the same Node version for pnpm and CI", () => {
    const npmrc = /^use-node-version=(.+)$/m.exec(read(".npmrc"))?.[1];
    expect(npmrc).toBe(read(".nvmrc").trim());
  });

  it.each(projects.map((p) => [p.path, p.manifest]))(
    "%s has exactly one type: and one platform: tag",
    (_path, manifest) => {
      const tags: string[] = manifest.nx?.tags ?? [];
      const types = tags.filter((t) => t.startsWith("type:")).map((t) => t.slice(5));
      const platforms = tags.filter((t) => t.startsWith("platform:")).map((t) => t.slice(9));
      expect(types).toHaveLength(1);
      expect(platforms).toHaveLength(1);
      expect(TYPES).toContain(types[0]);
      expect(PLATFORMS).toContain(platforms[0]);
    },
  );

  it.each(
    projects
      .filter((p) => p.path.startsWith("packages/") && p.path !== "packages/tsconfig")
      .map((p) => [p.path, p.manifest]),
  )("%s has the standard scripts and ships TypeScript source", (_path, manifest) => {
    expect(manifest.scripts).toMatchObject({
      typecheck: expect.any(String),
      lint: expect.any(String),
      test: expect.any(String),
    });
    expect(manifest.exports["."]).toBe("./src/index.ts");
  });

  it("keeps programs in apps/ and libraries in packages/", () => {
    for (const { path, manifest } of projects) {
      const isApp = (manifest.nx?.tags ?? []).includes("type:app");
      expect(isApp, `${path} is ${isApp ? "an app" : "a library"}`).toBe(path.startsWith("apps/"));
    }
  });

  it("uses one version of react, react-dom and react-native everywhere", () => {
    for (const dep of ["react", "react-dom", "react-native"]) {
      const versions = new Set(
        projects.flatMap(({ manifest }) =>
          ["dependencies", "devDependencies", "peerDependencies"]
            .map((field) => manifest[field]?.[dep])
            .filter(Boolean),
        ),
      );
      expect([...versions], dep).toHaveLength(versions.size === 0 ? 0 : 1);
    }
  });
});
