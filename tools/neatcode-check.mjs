// Runs the repo's neatcode rules (.neatcode/skills.yaml) as a gate: part of `pnpm check` and CI.
// Works around one neatcode 0.1.5 behaviour: `sync` keeps deleted files in the graph, so their
// old violations would still fail the check. Violations in files that no longer exist are dropped.
// Run through pnpm (`pnpm check` / `pnpm conventions`): neatcode's native SQLite module is built
// for the Node version pinned in .npmrc.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const neatcode = (...args) =>
  execFileSync(join(root, "node_modules/.bin/neatcode"), args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

neatcode("sync");

let report;
try {
  report = neatcode("validate", "--json");
} catch (err) {
  // `validate` exits 1 when it finds violations; the JSON report is still on stdout.
  if (err.status !== 1 || !err.stdout) throw err;
  report = err.stdout;
}
const { violations } = JSON.parse(report);
const live = violations.filter((v) => existsSync(join(root, v.location.file_path)));

if (live.length === 0) {
  console.log(
    `neatcode: no violations${violations.length ? ` (${violations.length} in deleted files ignored)` : ""}`,
  );
  process.exit(0);
}
for (const v of live) {
  console.error(`✖ [${v.rule_id}] ${v.message}\n    at ${v.location.file_path}:${v.location.line ?? 1}`);
}
console.error(
  `neatcode: ${live.length} violation(s). Fix the code; record an exception (neatcode exception add) only with the user's approval.`,
);
process.exit(1);
