import { readJson, type Tree } from "@nx/devkit";
import { createTreeWithEmptyWorkspace } from "@nx/devkit/testing";
import { beforeEach, describe, expect, it } from "vitest";
import libraryGenerator from "./generator.ts";

describe("library generator", () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it("creates a package that follows the workspace rules", async () => {
    await libraryGenerator(tree, { name: "worktree-manager", type: "service", platform: "node" });

    const pkg = readJson(tree, "packages/worktree-manager/package.json");
    expect(pkg.name).toBe("@coord/worktree-manager");
    expect(pkg.nx.tags).toEqual(["type:service", "platform:node"]);
    expect(Object.keys(pkg.scripts)).toEqual(["typecheck", "lint", "test"]);
    expect(pkg.devDependencies["@types/node"]).toBeDefined();
    expect(readJson(tree, "packages/worktree-manager/tsconfig.json").extends).toBe(
      "@coord/tsconfig/node.json",
    );
    expect(tree.exists("packages/worktree-manager/src/index.test.ts")).toBe(true);
  });

  it("sets up React and jsdom for UI packages", async () => {
    await libraryGenerator(tree, { name: "diff-view", type: "ui", platform: "dom" });
    const pkg = readJson(tree, "packages/diff-view/package.json");
    expect(pkg.peerDependencies).toEqual({ react: "19.3.0", "react-dom": "19.3.0" });
    expect(tree.read("packages/diff-view/vitest.config.ts", "utf-8")).toContain("jsdom");
  });

  it("keeps Node types out of cross-platform packages", async () => {
    await libraryGenerator(tree, { name: "shared", type: "lib", platform: "any" });
    expect(readJson(tree, "packages/shared/tsconfig.json").include).toEqual(["src"]);
  });

  it("rejects combinations that break the boundaries", async () => {
    await expect(libraryGenerator(tree, { name: "x", type: "adapter", platform: "any" })).rejects.toThrow(
      /node/,
    );
    await expect(libraryGenerator(tree, { name: "z", type: "service", platform: "dom" })).rejects.toThrow(
      /node/,
    );
    await expect(libraryGenerator(tree, { name: "y", type: "ui", platform: "react" })).rejects.toThrow(/dom/);
  });

  it("refuses to overwrite an existing package", async () => {
    await libraryGenerator(tree, { name: "dup", type: "lib", platform: "any" });
    await expect(libraryGenerator(tree, { name: "dup", type: "lib", platform: "any" })).rejects.toThrow(
      /exists/,
    );
  });
});
