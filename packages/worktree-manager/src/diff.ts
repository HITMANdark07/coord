import type { DiffView } from "@coord/protocol";
import { git } from "./git";

const PATCH_CAP = 1_000_000;

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
  const { cwd, baseRef } = opts;
  const base = (await git(["merge-base", baseRef, "HEAD"], { cwd })).trim();
  // Intent-to-add makes new untracked files show up in the working-tree diff.
  // Only the task worktree's index is touched, never the user's checkout.
  await git(["add", "--intent-to-add", "-A"], { cwd });

  const nameStatus = (await git(["diff", "--name-status", "-z", "-M", base], { cwd })).split("\0");
  const numstat = (await git(["diff", "--numstat", "-z", "-M", base], { cwd })).split("\0");

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
    patch = await git(["diff", "-M", base], { cwd, maxBuffer: PATCH_CAP + 1 });
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
