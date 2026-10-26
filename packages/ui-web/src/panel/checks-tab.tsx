import { useState } from "react";
import { useAction, useClient } from "@coord/app-state";
import { colors, space } from "@coord/design-tokens";
import type { Task } from "@coord/protocol";
import { InlineError } from "./inline-error";
import { sentNote } from "./message-box";

const c = colors.light;
const REVIEWABLE = ["review", "failed", "interrupted"];

type Draft = { feedback: string | null; onFeedback: (feedback: string | null) => void };

/**
 * Check results arrive in plan 3; until then this tab holds the review actions.
 * The send-back draft (null: the box is closed) lives in the panel, so it survives tab switches.
 */
export function ChecksTab({ task, feedback, onFeedback }: { task: Task } & Draft) {
  // Here, not in ReviewActions: a sent-back task leaves review, which unmounts them.
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div>
      <p style={{ color: c.muted }}>Checks run here once they're set up (coming next)</p>
      {REVIEWABLE.includes(task.status) && (
        <ReviewActions task={task} feedback={feedback} onFeedback={onFeedback} onSent={setSent} />
      )}
      {sent && (
        <p role="status" style={{ color: c.muted }}>
          {sent}
        </p>
      )}
    </div>
  );
}

function ReviewActions({
  task,
  feedback,
  onFeedback: setFeedback,
  onSent,
}: { task: Task; onSent: (note: string | null) => void } & Draft) {
  const client = useClient();
  const send = useAction(client.sendMessage);
  const discard = useAction(client.discard);
  const [confirming, setConfirming] = useState(false);

  const submit = async () => {
    if (!feedback?.trim() || send.pending) return;
    const note = sentNote(task.status);
    if (await send.run(task.id, feedback)) {
      setFeedback(null);
      onSent(note);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", gap: space.sm }}>
        {feedback === null && <button onClick={() => setFeedback("")}>Send back with feedback…</button>}
        {!confirming && <button onClick={() => setConfirming(true)}>Discard</button>}
      </div>
      {feedback !== null && (
        <div style={{ display: "flex", gap: space.xs }}>
          <textarea
            aria-label="Feedback"
            rows={3}
            style={{ flex: 1, font: "inherit" }}
            value={feedback}
            onChange={(e) => {
              setFeedback(e.target.value);
              onSent(null);
            }}
          />
          <button disabled={send.pending || !feedback.trim()} onClick={() => void submit()}>
            Send
          </button>
        </div>
      )}
      <InlineError error={send.error} />
      {confirming && (
        <span>
          Discard this task? The worktree is removed; its branch is kept for 14 days.{" "}
          <button disabled={discard.pending} onClick={() => void discard.run(task.id)}>
            Discard
          </button>{" "}
          <button onClick={() => setConfirming(false)}>Keep</button>
        </span>
      )}
      <InlineError error={discard.error} />
    </div>
  );
}
