import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import js from "@eslint/js";
import nx from "@nx/eslint-plugin";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * Package boundaries (see AGENTS.md). Every project carries one `type:` and one `platform:` tag
 * in its package.json "nx.tags". A violation fails lint, locally and in CI.
 */
const depConstraints = [
  // What each kind of project may import.
  { sourceTag: "type:contract", onlyDependOnLibsWithTags: [] },
  { sourceTag: "type:lib", onlyDependOnLibsWithTags: ["type:contract", "type:lib"] },
  { sourceTag: "type:state", onlyDependOnLibsWithTags: ["type:contract", "type:lib"] },
  { sourceTag: "type:ui", onlyDependOnLibsWithTags: ["type:contract", "type:lib", "type:state", "type:ui"] },
  { sourceTag: "type:adapter", onlyDependOnLibsWithTags: ["type:contract"] },
  // Daemon internals (worktree manager, SQLite store, git): only the daemon may use them.
  { sourceTag: "type:service", onlyDependOnLibsWithTags: ["type:contract", "type:lib", "type:service"] },
  {
    sourceTag: "type:daemon",
    onlyDependOnLibsWithTags: ["type:contract", "type:lib", "type:adapter", "type:service"],
  },
  // Apps never import the daemon, adapters or services: they talk to the daemon through @wto/client.
  { sourceTag: "type:app", onlyDependOnLibsWithTags: ["type:contract", "type:lib", "type:state", "type:ui"] },
  { sourceTag: "type:tooling", onlyDependOnLibsWithTags: [] },
  { sourceTag: "type:config", onlyDependOnLibsWithTags: [] },
  // Where code can run.
  { sourceTag: "platform:any", onlyDependOnLibsWithTags: ["platform:any"] },
  { sourceTag: "platform:node", onlyDependOnLibsWithTags: ["platform:node", "platform:any"] },
  { sourceTag: "platform:react", onlyDependOnLibsWithTags: ["platform:react", "platform:any"] },
  { sourceTag: "platform:dom", onlyDependOnLibsWithTags: ["platform:dom", "platform:react", "platform:any"] },
  {
    sourceTag: "platform:react-native",
    onlyDependOnLibsWithTags: ["platform:react-native", "platform:react", "platform:any"],
  },
  // Electron main is Node, the renderer is DOM; the renderer rule below keeps Node out of the renderer.
  {
    sourceTag: "platform:electron",
    onlyDependOnLibsWithTags: ["platform:node", "platform:dom", "platform:react", "platform:any"],
  },
];

/** Every project with its root and tags, read from package.json so new projects are covered. */
const projects = ["apps", "packages"]
  .flatMap((dir) => readdirSync(join(import.meta.dirname, dir)).map((name) => `${dir}/${name}`))
  .filter((root) => existsSync(join(import.meta.dirname, root, "package.json")))
  .map((root) => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, root, "package.json"), "utf8"));
    return { root, name: manifest.name, tags: manifest.nx?.tags ?? [] };
  });

/** Code that must run in every runtime (Node, browsers, React Native). */
const crossPlatformSources = projects
  .filter((p) => p.tags.includes("platform:any") || p.tags.includes("platform:react"))
  .map((p) => `${p.root}/src/**/*.{ts,tsx}`);

/** Node-only workspace packages: never allowed in a browser context. */
const nodeOnlyPackages = projects.filter((p) => p.tags.includes("platform:node")).map((p) => p.name);

const NODE_BUILTINS = [
  "fs",
  "path",
  "os",
  "child_process",
  "crypto",
  "http",
  "https",
  "net",
  "events",
  "stream",
  "util",
  "url",
  "worker_threads",
  "zlib",
];
/** Matches `node:x`, `x` and `x/sub` (e.g. `fs/promises`) for every Node built-in. */
const NODE_IMPORT = `^(node:.*|(${NODE_BUILTINS.join("|")})(/.*)?)$`;
/** The same pattern inside an AST selector's /regex/ literal, where "/" must be escaped. */
const NODE_IMPORT_SELECTOR = NODE_IMPORT.replaceAll("/", "\\/");

/** Bans Node built-ins and the listed workspace packages, in static and dynamic imports. */
const noNodeImports = (message, extraPackages = []) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: [{ regex: NODE_IMPORT, message }],
      paths: extraPackages.map((name) => ({ name, message })),
    },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: `ImportExpression[source.value=/${NODE_IMPORT_SELECTOR}/]`, message },
    ...extraPackages.map((name) => ({ selector: `ImportExpression[source.value='${name}']`, message })),
  ],
});

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dev-dist/**",
      "**/out/**",
      "**/.expo/**",
      "**/.nx/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "tools/workspace-plugin/src/generators/*/files/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    plugins: { "@nx": nx },
    rules: {
      "@nx/enforce-module-boundaries": ["error", { allow: [], depConstraints }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Cross-platform packages run in Node, browsers and React Native. TypeScript sees DOM types
    // everywhere (for fetch, AbortSignal, timers), so these rules keep runtime-specific APIs out.
    files: crossPlatformSources,
    ignores: ["**/*.test.{ts,tsx}", "**/testing.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["window", "document", "navigator", "localStorage", "sessionStorage", "location", "history"]
          .concat(["process", "Buffer", "__dirname", "__filename", "require"])
          .map((name) => ({
            name,
            message: "Not available in every runtime; keep this package platform-neutral.",
          })),
      ],
      "no-restricted-properties": [
        "error",
        ...["process", "Buffer", "window", "document"].map((property) => ({
          object: "globalThis",
          property,
          message: "Not available in every runtime; keep this package platform-neutral.",
        })),
      ],
      ...noNodeImports("Node APIs are not allowed in cross-platform packages."),
    },
  },
  {
    // The Electron renderer and preload are sandboxed browser contexts, even though the
    // desktop project as a whole may use Node packages (in its main process).
    // shared/ is bundled into the renderer too.
    files: [
      "apps/desktop/src/renderer/**/*.{ts,tsx}",
      "apps/desktop/src/preload/**/*.ts",
      "apps/desktop/src/shared/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: noNodeImports("The Electron renderer and preload have no Node access.", nodeOnlyPackages),
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable", require: "readonly" } },
  },
  prettier,
);
