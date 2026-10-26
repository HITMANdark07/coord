import type { DiffView } from "@coord/protocol";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git";

const PATCH_CAP = 1_000_000;
/**
 * The diff is parsed and shown to clients, so the user's diff config (an external diff tool,
 * textconv, colors, no a/ b/ prefixes) must not change its format.
 */
const PLAIN = ["--no-ext-diff", "--no-color", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

type File = DiffView["files"][number];

const STATUS: Record<string, File["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

export async function diffAgainstBase(opts: { cwd: string; baseRef: string }): Promise<DiffView> {
  // Intent-to-add makes new untracked files show up in the diff, but doing it in the real
  // index would break the agent's `git stash` and make deleted files look like changes.
  // So work on a private copy of the index.
  const indexPath = resolve(
    opts.cwd,
    (await git(["rev-parse", "--git-path", "index"], { cwd: opts.cwd })).trim(),
  );
  const dir = await mkdtemp(join(tmpdir(), "coord-diff-"));
  try {
    const tmpIndex = join(dir, "index");
    await copyFile(indexPath, tmpIndex);
    return await diffWithIndex(opts.cwd, opts.baseRef, { GIT_INDEX_FILE: tmpIndex });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function diffWithIndex(cwd: string, baseRef: string, env: Record<string, string>): Promise<DiffView> {
  // --end-of-options: the base ref is derived from a client's branch name.
  const base = (await git(["merge-base", "--end-of-options", baseRef, "HEAD"], { cwd, env })).trim();
  await git(["add", "--intent-to-add", "-A"], { cwd, env });

  const nameStatus = (await git(["diff", ...PLAIN, "--name-status", "-z", "-M", base], { cwd, env })).split(
    "\0",
  );
  const numstat = (await git(["diff", ...PLAIN, "--numstat", "-z", "-M", base], { cwd, env })).split("\0");

  const counts = new Map<string, { additions: number; deletions: number }>();
  for (let i = 0; i < numstat.length; i++) {
    const rec = numstat[i];
    if (!rec) continue;
    const [a = "", d = "", p = ""] = rec.split("\t");
    // Binary files report "-"; count them as 0 instead of NaN.
    const entry = { additions: Number(a) || 0, deletions: Number(d) || 0 };
    // Renames: empty path, then old and new as the next two records.
    const path = p === "" ? (numstat[i + 2] ?? "") : p;
    if (p === "") i += 2;
    counts.set(path, entry);
  }

  const files: File[] = [];
  for (let i = 0; i < nameStatus.length; i++) {
    const code = nameStatus[i];
    if (!code) continue;
    const letter = code[0] ?? "M";
    const isMove = letter === "R" || letter === "C";
    const path = isMove ? (nameStatus[i + 2] ?? "") : (nameStatus[i + 1] ?? "");
    i += isMove ? 2 : 1;
    files.push({
      path,
      status: STATUS[letter] ?? "modified",
      ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
    });
  }

  let patch: string;
  let truncated = false;
  try {
    patch = await git(["diff", ...PLAIN, "-M", base], { cwd, env, maxBuffer: PATCH_CAP + 1 });
  } catch (e) {
    const partial = (e as { stdout?: string }).stdout;
    if (partial === undefined || partial.length === 0) throw e;
    patch = partial;
    truncated = true;
  }
  if (patch.length > PATCH_CAP) {
    patch = patch.slice(0, PATCH_CAP);
    truncated = true;
  }
  return { baseRef, files, patch, truncated };
}
