import { useCallback } from "react";
import { useClient, useLiveQuery } from "@coord/app-state";
import { colors, fontSize, space, statusColors } from "@coord/design-tokens";
import { displayText, type DaemonEvent, type Task } from "@coord/protocol";
import { splitPatch } from "./split-patch";

const c = colors.light;
const mono = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: fontSize.sm } as const;

const lineColor = (line: string) =>
  line.startsWith("+") ? statusColors.merged : line.startsWith("-") ? statusColors.failed : c.muted;

/** The task's changes against its base branch (PRD FR-20); reloads when the task changes. */
export function DiffTab({ task }: { task: Task }) {
  const client = useClient();
  const id = task.id;
  const load = useCallback(() => client.taskDiff(id), [client, id]);
  const refreshOn = useCallback(
    (event: DaemonEvent) => event.payload.kind === "task.updated" && event.payload.task.id === id,
    [id],
  );
  const query = useLiveQuery(load, { intervalMs: 15_000, refreshOn });

  if (query.status === "loading") return <p>Loading…</p>;
  // A failed poll keeps the last diff on screen; the 409 for a task without a worktree has none.
  if (query.status === "error" && !query.data) return <p role="alert">{displayText(query.error)}</p>;
  const diff = query.data;
  if (!diff) return null;
  if (diff.files.length === 0) return <p style={{ color: c.muted }}>No changes yet</p>;

  const sections = new Map(splitPatch(diff.patch).map((s) => [s.path, s]));
  const added = diff.files.reduce((n, f) => n + f.additions, 0);
  const removed = diff.files.reduce((n, f) => n + f.deletions, 0);
  const n = diff.files.length;

  return (
    <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <p style={{ margin: 0, color: c.muted }}>
        {`${n} file${n === 1 ? "" : "s"} · +${added} −${removed} · base ${displayText(diff.baseRef)}`}
      </p>
      {diff.truncated && (
        <p role="status" style={{ color: statusColors.needs_input }}>
          Diff truncated — open the worktree to see everything
          {task.worktreePath ? `: ${displayText(task.worktreePath)}` : ""}
        </p>
      )}
      {diff.files.map((file) => {
        const section = sections.get(file.path);
        return (
          <section key={file.path} style={{ marginTop: space.md }}>
            <div style={{ display: "flex", gap: space.sm, alignItems: "baseline" }}>
              <strong style={mono}>{displayText(file.path)}</strong>
              <span style={{ color: c.muted, fontSize: fontSize.sm }}>{file.status}</span>
              <span
                style={{ color: statusColors.merged, fontSize: fontSize.sm }}
              >{`+${file.additions}`}</span>
              <span
                style={{ color: statusColors.failed, fontSize: fontSize.sm }}
              >{`−${file.deletions}`}</span>
            </div>
            {section?.binary ? (
              <div style={{ color: c.muted }}>Binary file changed</div>
            ) : (
              <pre style={{ ...mono, margin: 0, background: c.surface, overflowX: "auto" }}>
                {section?.lines.map((line, i) => (
                  // Agent-written text: a React text node, never HTML. displayText strips control characters.
                  <div key={i} style={{ color: lineColor(line) }}>
                    {displayText(line)}
                  </div>
                ))}
              </pre>
            )}
          </section>
        );
      })}
    </div>
  );
}
