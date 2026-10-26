import { useState } from "react";
import { useDaemonStatus } from "@coord/app-state";
import { colors, fontSize, radius, space } from "@coord/design-tokens";
import { Board } from "./board/board";
import { ErrorBoundary } from "./error-boundary";

export type Notify = (n: { title: string; body: string; onClick: () => void }) => void;
export interface AppPlatform {
  pickFolder?: () => Promise<string | null>;
  notify?: Notify;
}

const c = colors.light;

/** Root screen shared by the desktop window and the PWA. Each app wraps it in <ClientProvider>. */
export function App({ surface }: { surface: "desktop" | "web"; platform?: AppPlatform }) {
  // Task 5 renders the panel for this id; Task 7 opens the new-task form.
  const [, setOpenTaskId] = useState<string | null>(null);
  return (
    <ErrorBoundary>
      <main style={{ fontFamily: "system-ui, sans-serif", color: c.text, padding: space.xl }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: space.md, marginBottom: space.lg }}>
          <h1 style={{ fontSize: fontSize.xxl, margin: 0 }}>Coord</h1>
          <span style={{ color: c.muted, fontSize: fontSize.sm }}>{surface}</span>
        </header>
        <DaemonBanner />
        <Board onOpen={setOpenTaskId} onNewTask={() => {}} />
      </main>
    </ErrorBoundary>
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
