import { useState, type ReactNode } from "react";
import { useAgents, usePermissions, useTasks } from "@coord/app-state";
import { colors, fontSize, space } from "@coord/design-tokens";
import { displayText, toolInputSummary, type PermissionRequestView, type Task } from "@coord/protocol";
import { useNow } from "../use-now";
import { boardSummary, COLUMNS, groupTasks } from "./columns";
import { TaskCard } from "./task-card";

const c = colors.light;

function needsYouDetail(task: Task, permissions: PermissionRequestView[]): string {
  const pending = permissions.find((p) => p.taskId === task.id);
  if (pending) return toolInputSummary(pending.tool, pending.input);
  if (task.error) return displayText(task.error);
  if (task.status === "interrupted") return "interrupted — resume";
  return task.status === "needs_input" ? "waiting for you" : task.status;
}

export function Board({
  onOpen,
  onNewTask,
  repoId,
  repoSwitcher,
}: {
  onOpen: (taskId: string) => void;
  onNewTask: () => void;
  repoId: string;
  /** Sits at the left of the board header. */
  repoSwitcher?: ReactNode;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const now = useNow();
  const tasks = useTasks({ repoId, all: showClosed });
  const permissions = usePermissions();
  const agents = useAgents();
  // Until agents load, only Claude Code is assumed to report cost.
  const costReporting = (agent: string) =>
    agents.status === "ok"
      ? (agents.data.find((a) => a.id === agent)?.costReporting ?? false)
      : agent === "claude-code";

  const data = tasks.status === "loading" ? [] : (tasks.data ?? []);
  const groups = groupTasks(data, { now, showClosed });
  const pending = permissions.status === "loading" ? [] : (permissions.data ?? []);

  return (
    <section>
      <header style={{ display: "flex", alignItems: "center", gap: space.md, marginBottom: space.lg }}>
        {repoSwitcher}
        <span style={{ color: c.muted, fontSize: fontSize.sm }}>
          {tasks.status === "loading" ? "" : boardSummary(data)}
        </span>
        <button onClick={onNewTask}>+ New task</button>
      </header>
      {tasks.status === "error" && <p role="alert">Could not load tasks: {displayText(tasks.error)}</p>}
      <div style={{ display: "flex", gap: space.sm, alignItems: "flex-start" }}>
        {COLUMNS.filter((col) => col.id !== "closed" || showClosed).map((col) => (
          <div key={col.id} style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                fontSize: fontSize.sm,
                color: c.muted,
                textTransform: "uppercase",
                margin: `0 0 ${space.sm}px`,
              }}
            >
              {col.label}
            </h2>
            {groups[col.id].map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                now={now}
                costReporting={costReporting(t.agent)}
                detail={col.id === "needs_you" ? needsYouDetail(t, pending) : undefined}
                onOpen={onOpen}
              />
            ))}
            {col.id === "merged" && (
              <label style={{ fontSize: fontSize.sm, color: c.muted }}>
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(e) => setShowClosed(e.target.checked)}
                />{" "}
                show closed
              </label>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
