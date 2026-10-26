import { useDaemonStatus, useTasks } from "@wto/app-state";
import { colors, fontSize, radius, space, statusColors } from "@wto/design-tokens";
import type { Task } from "@wto/protocol";

const c = colors.light;

/** Root screen shared by the desktop window and the PWA. Each app wraps it in <ClientProvider>. */
export function App({ surface }: { surface: "desktop" | "web" }) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", color: c.text, padding: space.xl, maxWidth: 880 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: space.md, marginBottom: space.xl }}>
        <h1 style={{ fontSize: fontSize.xxl, margin: 0 }}>Worktree Orchestrator</h1>
        <span style={{ color: c.muted, fontSize: fontSize.sm }}>{surface}</span>
      </header>
      <DaemonBanner />
      <TaskList />
    </main>
  );
}

function DaemonBanner() {
  const daemon = useDaemonStatus();
  const text =
    daemon.status === "ok"
      ? `Daemon connected · v${daemon.data.daemonVersion} · protocol ${daemon.data.protocolVersion}`
      : daemon.status === "error"
        ? `Daemon unreachable: ${daemon.error}`
        : "Connecting to daemon…";
  return (
    <p
      role="status"
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: radius.md,
        padding: space.md,
      }}
    >
      {text}
    </p>
  );
}

function TaskList() {
  const tasks = useTasks();
  if (tasks.status !== "ok") return null;
  if (tasks.data.length === 0) return <p style={{ color: c.muted }}>No tasks yet.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {tasks.data.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </ul>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li
      style={{
        display: "flex",
        gap: space.md,
        padding: `${space.sm}px 0`,
        borderBottom: `1px solid ${c.border}`,
      }}
    >
      <span style={{ color: statusColors[task.status], minWidth: 96 }}>{task.status}</span>
      <span>{task.title}</span>
    </li>
  );
}
