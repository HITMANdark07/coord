import type { Task } from "@coord/protocol";

export type ColumnId = "queued" | "running" | "needs_you" | "review" | "pr_open" | "merged" | "closed";

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "needs_you", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "pr_open", label: "PR open" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
];

const MERGED_VISIBLE_MS = 7 * 86_400_000;

const BY_STATUS: Record<string, ColumnId> = {
  queued: "queued",
  setting_up: "running",
  running: "running",
  checking: "running",
  review: "review",
  pr_open: "pr_open",
};

export function columnFor(task: Task, now: Date): ColumnId {
  const fixed = BY_STATUS[task.status];
  if (fixed) return fixed;
  if (task.status === "merged")
    return now.getTime() - Date.parse(task.updatedAt) <= MERGED_VISIBLE_MS ? "merged" : "closed";
  if (task.status === "closed" || task.status === "cancelled" || task.status === "cleaned_up")
    return "closed";
  // needs_input, failed, interrupted, and a status from a newer daemon: the user should look at them.
  return "needs_you";
}

export function groupTasks(
  tasks: Task[],
  opts: { now: Date; showClosed: boolean },
): Record<ColumnId, Task[]> {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.id, [] as Task[]])) as Record<ColumnId, Task[]>;
  for (const t of tasks) {
    const column = columnFor(t, opts.now);
    if (column !== "closed" || opts.showClosed) groups[column].push(t);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return groups;
}

export function boardSummary(tasks: Task[]): string {
  // Counted by status, not by column: the merged-after-7-days rule needs a clock and these don't.
  const count = (pred: (t: Task) => boolean) => tasks.filter(pred).length;
  const parts = [
    [count((t) => BY_STATUS[t.status] === "running"), "running"],
    [
      count((t) => BY_STATUS[t.status] === undefined && columnFor(t, new Date(0)) === "needs_you"),
      "needs you",
    ],
    [count((t) => t.status === "review"), "in review"],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return text.length > 0 ? text.join(" · ") : tasks.length === 0 ? "No tasks yet" : "";
}
