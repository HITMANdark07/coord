export type FilePatch = { path: string; lines: string[]; binary: boolean };

/** Splits a unified git patch into one section per file; `lines` start at the first hunk header. */
export function splitPatch(patch: string): FilePatch[] {
  const out: FilePatch[] = [];
  let section: string[] = [];
  const flush = (path: string | undefined) => {
    if (path === undefined) return;
    const hunk = section.findIndex((l) => l.startsWith("@@"));
    out.push({
      path,
      binary: section.some((l) => /^Binary files .* differ$/.test(l)),
      lines: hunk === -1 ? [] : section.slice(hunk),
    });
  };
  let path: string | undefined;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      flush(path);
      path = header[1];
      section = [];
    } else section.push(line);
  }
  flush(path);
  // The patch's final newline leaves one empty trailing line in the last section.
  for (const f of out) if (f.lines.at(-1) === "") f.lines.pop();
  return out;
}
