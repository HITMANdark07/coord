import { useState } from "react";
import { useAction, useClient } from "@coord/app-state";
import { colors, fontSize, space } from "@coord/design-tokens";
import { displayText, type Task } from "@coord/protocol";

const CLOSED = ["cancelled", "cleaned_up", "closed"];

/** A follow-up into the same session (PRD FR-17). */
export function MessageBox({ task }: { task: Task }) {
  const client = useClient();
  const [text, setText] = useState("");
  const send = useAction(client.sendMessage);
  const disabled = CLOSED.includes(task.status);
  const submit = async () => {
    if (!text.trim() || send.pending) return;
    const sent = text;
    // Keep anything typed while the send was in flight.
    if (await send.run(task.id, sent)) setText((t) => (t === sent ? "" : t));
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
          onChange={(e) => setText(e.target.value)}
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
      {/* The daemon queues a message sent mid-turn and delivers it when the turn ends. */}
      {(task.status === "running" || task.status === "needs_input") && (
        <p style={{ color: colors.light.muted, fontSize: fontSize.sm, margin: `${space.xs}px 0 0` }}>
          Delivered when the current turn ends
        </p>
      )}
      {send.error && <p role="alert">{displayText(send.error)}</p>}
    </div>
  );
}
