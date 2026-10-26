export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "task";
}

/** The first non-empty line: what a task's title (and so its branch) is made from. */
export function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0) ?? text;
}

/** The branch the daemon would pick for this prompt, shown in the New task form before it's created. */
export function branchSuggestion(prompt: string): string {
  return `agent/${slugify(firstLine(prompt))}`;
}
