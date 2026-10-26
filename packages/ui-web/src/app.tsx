import { useState } from "react";
import { useDaemonStatus, useRepos } from "@coord/app-state";
import { displayText } from "@coord/protocol";
import { colors, fontSize, radius, space } from "@coord/design-tokens";
import { Board } from "./board/board";
import { ErrorBoundary } from "./error-boundary";
import { TaskPanel } from "./panel/task-panel";
import { AddRepo } from "./repos/add-repo";
import { NewTaskForm } from "./new-task/new-task-form";
import { browserNotifier } from "./notifications/notifier";
import { useTaskNotifications } from "./notifications/use-task-notifications";
import { RepoSwitcher, useSelectedRepo } from "./repos/repo-switcher";

export type Notify = (n: { title: string; body: string; onClick: () => void }) => void;
export interface AppPlatform {
  pickFolder?: () => Promise<string | null>;
  notify?: Notify;
}

const c = colors.light;
const noNotify: Notify = () => {};

/** Root screen shared by the desktop window and the PWA. Each app wraps it in <ClientProvider>. */
export function App({ surface, platform }: { surface: "desktop" | "web"; platform?: AppPlatform }) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const repos = useRepos();
  const list = repos.status === "loading" ? [] : (repos.data ?? []);
  const [selected, select] = useSelectedRepo(list);
  const notify = platform?.notify ?? browserNotifier();
  useTaskNotifications(notify ?? noNotify, setOpenTaskId);
  return (
    <ErrorBoundary>
      <main style={{ fontFamily: "system-ui, sans-serif", color: c.text, padding: space.xl }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: space.md, marginBottom: space.lg }}>
          <h1 style={{ fontSize: fontSize.xxl, margin: 0 }}>Coord</h1>
          <span style={{ color: c.muted, fontSize: fontSize.sm }}>{surface}</span>
          {surface === "web" && !platform?.notify && <EnableNotifications />}
        </header>
        <DaemonBanner />
        {repos.status === "error" && <p role="alert">Could not load repos: {displayText(repos.error)}</p>}
        {creating && (
          <NewTaskForm
            repoId={selected?.id ?? null}
            surface={surface}
            onCreated={(id) => {
              setCreating(false);
              setOpenTaskId(id);
            }}
            onClose={() => setCreating(false)}
          />
        )}
        {selected ? (
          <Board
            repoId={selected.id}
            onOpen={setOpenTaskId}
            onNewTask={() => setCreating(true)}
            repoSwitcher={
              <RepoSwitcher
                repos={list}
                selected={selected}
                onSelect={select}
                surface={surface}
                platform={platform}
              />
            }
          />
        ) : (
          repos.status === "ok" && (
            <section>
              <p>Add a repo to start</p>
              <AddRepo platform={platform} onAdded={(repo) => select(repo.id)} />
            </section>
          )
        )}
        {openTaskId && (
          // Keyed so a different task starts on its own Live tab with an empty message box.
          <TaskPanel
            key={openTaskId}
            taskId={openTaskId}
            surface={surface}
            onClose={() => setOpenTaskId(null)}
          />
        )}
      </main>
    </ErrorBoundary>
  );
}

/** Browsers only grant permission from a user gesture, so the web surface asks from a click. */
function EnableNotifications() {
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  if (permission !== "default") return null;
  return (
    <button type="button" onClick={() => void Notification.requestPermission().then(setPermission)}>
      Enable notifications
    </button>
  );
}

function DaemonBanner() {
  const daemon = useDaemonStatus();
  const text =
    daemon.status === "ok"
      ? `Daemon connected · v${daemon.data.daemonVersion} · protocol ${daemon.data.protocolVersion}`
      : daemon.status === "error"
        ? `Daemon unreachable: ${displayText(daemon.error)}`
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
