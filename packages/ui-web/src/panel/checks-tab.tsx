import { useState } from "react";
import { useAction, useClient } from "@coord/app-state";
import { colors, fontSize, space, statusColors } from "@coord/design-tokens";
import { displayText, type Task } from "@coord/protocol";

const c = colors.light;
const REVIEWABLE = ["review", "failed", "interrupted"];

/** Check results arrive in plan 3; until then this tab holds the review actions. */
export function ChecksTab({ task }: { task: Task }) {
  return (
    <div>
      <p style={{ color: c.muted }}>Checks run here once they're set up (coming next)</p>
      {REVIEWABLE.includes(task.status) && <ReviewActions task={task} />}
    </div>
  );
}

function ReviewActions({ task }: { task: Task }) {
  const client = useClient();
  const send = useAction(client.sendMessage);
  const discard = useAction(client.discard);
  const [feedback, setFeedback] = useState<string | null>(null); // null: the box is closed
  const [confirming, setConfirming] = useState(false);

  const submit = async () => {
    if (!feedback?.trim() || send.pending) return;
    if (await send.run(task.id, feedback)) setFeedback(null);
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
            onChange={(e) => setFeedback(e.target.value)}
          />
          <button disabled={send.pending || !feedback.trim()} onClick={() => void submit()}>
            Send
          </button>
        </div>
      )}
      <Error message={send.error} />
      {confirming && (
        <span>
          Discard this task? The worktree is removed; its branch is kept for 14 days.{" "}
          <button disabled={discard.pending} onClick={() => void discard.run(task.id)}>
            Discard
          </button>{" "}
          <button onClick={() => setConfirming(false)}>Keep</button>
        </span>
      )}
      <Error message={discard.error} />
    </div>
  );
}

const Error = ({ message }: { message: string | null }) =>
  message && (
    <span role="alert" style={{ color: statusColors.failed, fontSize: fontSize.sm }}>
      {displayText(message)}
    </span>
  );
