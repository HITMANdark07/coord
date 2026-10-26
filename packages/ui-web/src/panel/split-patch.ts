export type FilePatch = { path: string; lines: string[]; binary: boolean };

const ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };

/** Undoes git's C-style path quoting: octal escapes are the UTF-8 bytes of the name. */
function unquote(quoted: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < quoted.length; i++) {
    const ch = quoted[i] as string;
    const octal = ch === "\\" ? /^[0-7]{3}/.exec(quoted.slice(i + 1)) : null;
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (ch === "\\" && quoted[i + 1] !== undefined) {
      bytes.push(ESCAPES[quoted[++i] as string] ?? (quoted[i] as string).charCodeAt(0));
    } else bytes.push(...enc.encode(ch));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// Git quotes a name with non-ASCII bytes (unless core.quotepath=false), a tab, a quote or a backslash.
const QUOTED_B = /^diff --git .* "b\/((?:[^"\\]|\\.)*)"$/;
const PLAIN_B = /^diff --git "?a\/.+ b\/(.+)$/;

function headerPath(line: string): string | undefined {
  const quoted = QUOTED_B.exec(line);
  if (quoted) return unquote(quoted[1] as string);
  return PLAIN_B.exec(line)?.[1];
}

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
  for (const line of patch.split(/\r?\n/)) {
    const next = headerPath(line);
    if (next !== undefined) {
      flush(path);
      path = next;
      section = [];
    } else section.push(line);
  }
  flush(path);
  // The patch's final newline leaves one empty trailing line in the last section.
  for (const f of out) if (f.lines.at(-1) === "") f.lines.pop();
  return out;
}
