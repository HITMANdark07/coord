/**
 * C0 and C1 control characters (other than tab and newline, which callers render) and format
 * characters (bidi overrides, zero-width and direction marks). Agent text and tool input are shown
 * through here: an ESC sequence could erase or recolor part of a command the user is about to
 * allow, a bidi override reorder it, a zero-width character hide a difference.
 */
const CONTROL = /(?![\t\n])[\p{Cc}\p{Cf}]/gu;

/** Untrusted text (agent output, tool input) made safe to show. */
export function displayText(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * One display-safe line of at most `max` characters. `cut: "middle"` keeps the end, for paths
 * whose file name is what the user must see (acceptance run 2, D3).
 */
function oneLine(text: string, max: number, cut: "end" | "middle"): string {
  const flat = displayText(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (cut === "end") return `${flat.slice(0, max - 1)}…`;
  const tail = Math.ceil(((max - 1) * 2) / 3);
  return `${flat.slice(0, max - 1 - tail)}…${flat.slice(-tail)}`;
}

/** Tools whose input names the file they change; the path is what the user must judge. */
const FILE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/**
 * What a tool call would do, on one line (acceptance D2): the tool name alone can't be judged.
 * The Bash command, the file an edit writes, or else the input as JSON. A newline shows as ⏎:
 * a second line of a Bash command is a second command.
 */
export function toolInputSummary(tool: string, input: unknown, max = 120): string {
  const fields = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => fields[k]).find((v) => typeof v === "string") as string | undefined;
  const path = FILE_TOOLS.includes(tool) ? pick("file_path", "notebook_path", "path") : undefined;
  if (path !== undefined) return oneLine(path, max, "middle");
  const text = (tool === "Bash" ? pick("command") : undefined) ?? JSON.stringify(input) ?? "";
  return oneLine(text.replace(/\r?\n/g, "⏎"), max, "end");
}
