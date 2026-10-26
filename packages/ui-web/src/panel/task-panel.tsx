import { useEffect, useRef, useState } from "react";
import { useAction, useClient, useTask } from "@coord/app-state";
import { colors, fontSize, space, statusColors } from "@coord/design-tokens";
import { displayText, type Task } from "@coord/protocol";
import { agentLabel } from "../format";
import { useFocusWhileOpen } from "../use-focus-while-open";
import { ChecksTab } from "./checks-tab";
import { DiffTab } from "./diff-tab";
import { InlineError } from "./inline-error";
import { LiveTab } from "./live-tab";

const c = colors.light;
const TABS = ["Live", "Diff", "Checks"] as const;
const INTERRUPTIBLE = ["running", "needs_input"];
const RESUMABLE = ["interrupted", "failed"];
// Review, failed and interrupted tasks are discarded from the Checks tab instead.
const CANCELLABLE = ["queued", "setting_up", "running", "needs_input"];
// Inputs whose value is typed text; a checkbox or radio always has the value "on".
const TEXT_INPUTS = ["text", "search", "url", "email", "password", "number"];

/** Slides in from the right over the board, which stays visible (spec §4). */
export function TaskPanel({
  taskId,
  onClose,
}: {
  taskId: string;
  surface: "desktop" | "web";
  onClose: () => void;
}) {
  const query = useTask(taskId);
  const task = query && query.status !== "loading" ? query.data : undefined;
  const [tab, setTab] = useState<(typeof TABS)[number]>("Live");
  const panel = useRef<HTMLElement>(null);
  // Here, not in the tabs, so switching tabs keeps half-written text (App keys the panel by task).
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null); // null: the send-back box is closed
  useFocusWhileOpen(panel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      // Esc in a field holding text would throw away a half-written follow-up or Deny reason.
      const t = e.target;
      const typing =
        t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && TEXT_INPUTS.includes(t.type));
      if (typing && t.value) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const el = panel.current;
    // jsdom has no Web Animations API.
    if (el && "animate" in el) el.animate([{ transform: "translateX(100%)" }, { transform: "none" }], 150);
  }, []);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Task"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(560px, 100vw)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: space.lg,
        background: c.bg,
        borderLeft: `1px solid ${c.border}`,
        boxShadow: "-8px 0 24px rgba(0, 0, 0, 0.08)",
        zIndex: 10,
      }}
    >
      <button
        aria-label="Close"
        onClick={onClose}
        style={{
          position: "absolute",
          top: space.sm,
          right: space.sm,
          font: "inherit",
          fontSize: fontSize.lg,
        }}
      >
        ×
      </button>
      {query?.status === "error" && <p role="alert">Could not load the task: {displayText(query.error)}</p>}
      {task ? (
        <>
          <Header task={task} />
          <div
            role="tablist"
            style={{ display: "flex", gap: space.xs, borderBottom: `1px solid ${c.border}` }}
          >
            {TABS.map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                style={{ font: "inherit", fontWeight: tab === name ? 600 : 400 }}
              >
                {name}
              </button>
            ))}
          </div>
          {tab === "Live" ? (
            <LiveTab task={task} message={message} onMessage={setMessage} />
          ) : tab === "Diff" ? (
            <DiffTab task={task} />
          ) : (
            <ChecksTab task={task} feedback={feedback} onFeedback={setFeedback} />
          )}
        </>
      ) : (
        query?.status === "loading" && <p>Loading…</p>
      )}
    </aside>
  );
}

function Header({ task }: { task: Task }) {
  const client = useClient();
  const interrupt = useAction(client.interrupt);
  const resume = useAction(client.resumeTask);
  const cancel = useAction(client.cancel);
  const [confirming, setConfirming] = useState(false);
  const n = task.turns;

  return (
    <header style={{ paddingRight: space.xl }}>
      <h2 style={{ fontSize: fontSize.lg, margin: 0 }}>{displayText(task.title)}</h2>
      <div style={{ color: c.muted, fontSize: fontSize.sm }}>
        {`${agentLabel(task.agent)} · ${task.model ? displayText(task.model) : "default model"} · branch ${
          task.branch ? displayText(task.branch) : "—"
        } · ${n} commit${n === 1 ? "" : "s"}`}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space.sm,
          marginTop: space.xs,
        }}
      >
        <span style={{ color: statusColors[task.status], fontWeight: 600 }}>{task.status}</span>
        {INTERRUPTIBLE.includes(task.status) && (
          <button disabled={interrupt.pending} onClick={() => void interrupt.run(task.id)}>
            Interrupt
          </button>
        )}
        <InlineError error={interrupt.error} />
        {RESUMABLE.includes(task.status) && (
          <button disabled={resume.pending} onClick={() => void resume.run(task.id)}>
            Resume
          </button>
        )}
        <InlineError error={resume.error} />
        {CANCELLABLE.includes(task.status) &&
          (confirming ? (
            <span>
              Cancel this task? Work so far is committed to its branch.{" "}
              <button
                disabled={cancel.pending}
                onClick={() => void cancel.run(task.id).then(() => setConfirming(false))}
              >
                Cancel task
              </button>{" "}
              <button onClick={() => setConfirming(false)}>Keep</button>
            </span>
          ) : (
            <button onClick={() => setConfirming(true)}>Cancel</button>
          ))}
        <InlineError error={cancel.error} />
      </div>
    </header>
  );
}
