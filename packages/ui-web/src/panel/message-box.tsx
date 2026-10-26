import { useState, type Dispatch, type SetStateAction } from "react";
import { useAction, useClient } from "@coord/app-state";
import { colors, fontSize, space } from "@coord/design-tokens";
import { displayText, type Task } from "@coord/protocol";

const CLOSED = ["cancelled", "cleaned_up", "closed"];
const MID_TURN = ["running", "needs_input"];
const note = { color: colors.light.muted, fontSize: fontSize.sm, margin: `${space.xs}px 0 0` };

/** Confirms a sent message, with the status it was sent in: the daemon queues one sent mid-turn. */
export const sentNote = (status: string) =>
  MID_TURN.includes(status) ? "Sent — delivered when the current turn ends" : "Sent";

/** A follow-up into the same session (PRD FR-17). The draft lives in the panel, so it survives tab switches. */
export function MessageBox({
  task,
  text,
  onText,
}: {
  task: Task;
  text: string;
  onText: Dispatch<SetStateAction<string>>;
}) {
  const client = useClient();
  const send = useAction(client.sendMessage);
  const [sent, setSent] = useState<string | null>(null); // shown until the next keystroke
  const disabled = CLOSED.includes(task.status);
  const submit = async () => {
    if (!text.trim() || send.pending) return;
    const draft = text;
    const confirmation = sentNote(task.status);
    if (await send.run(task.id, draft)) {
      // Keep anything typed while the send was in flight.
      onText((t) => (t === draft ? "" : t));
      setSent(confirmation);
    }
  };

  return (
    <div style={{ borderTop: `1px solid ${colors.light.border}`, paddingTop: space.sm }}>
      <div style={{ display: "flex", gap: space.xs }}>
        <textarea
          aria-label="Message the agent"
          placeholder="Message the agent (it continues the same session)…"
          rows={2}
          style={{ flex: 1, font: "inherit" }}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            onText(e.target.value);
            setSent(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button disabled={disabled || send.pending} onClick={() => void submit()}>
          Send
        </button>
      </div>
      {sent ? (
        <p role="status" style={note}>
          {sent}
        </p>
      ) : (
        // The daemon queues a message sent mid-turn and delivers it when the turn ends.
        MID_TURN.includes(task.status) && <p style={note}>Delivered when the current turn ends</p>
      )}
      {send.error && <p role="alert">{displayText(send.error)}</p>}
    </div>
  );
}
