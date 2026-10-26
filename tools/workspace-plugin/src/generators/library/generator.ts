import * as path from "node:path";
import { formatFiles, generateFiles, installPackagesTask, names, type Tree } from "@nx/devkit";
import type { LibraryGeneratorSchema } from "./schema.d.ts";

const TSCONFIG_PRESET = { any: "base", node: "node", react: "react", dom: "dom" } as const;

/** `nx g @wto/workspace-plugin:library <name> --type=lib --platform=any` */
export default async function libraryGenerator(tree: Tree, options: LibraryGeneratorSchema) {
  const name = names(options.name).fileName;
  const root = `packages/${name}`;
  if (tree.exists(root)) throw new Error(`${root} already exists`);
  if ((options.type === "adapter" || options.type === "service") && options.platform !== "node") {
    throw new Error(`${options.type} packages run in the daemon: use --platform=node`);
  }
  if (options.type === "ui" && options.platform !== "dom")
    throw new Error("ui packages render React DOM: use --platform=dom");

  generateFiles(tree, path.join(import.meta.dirname, "files"), root, {
    name,
    type: options.type,
    platform: options.platform,
    tsconfigPreset: TSCONFIG_PRESET[options.platform],
    usesReact: options.platform === "react" || options.platform === "dom",
    usesNode: options.platform === "node",
    tmpl: "",
  });

  await formatFiles(tree);
  // Always install: the new package's workspace links and lockfile entry are needed before any check runs.
  return () => installPackagesTask(tree, true);
}
