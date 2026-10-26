import { useState } from "react";
import { useAction, useClient } from "@coord/app-state";
import { radius, space } from "@coord/design-tokens";
import {
  displayText,
  toolInputSummary,
  type PermissionDecision,
  type PermissionRequestView,
} from "@coord/protocol";

/** One pending prompt, inline in the Live tab (PRD FR-4). */
export function PermissionPrompt({ request, agent }: { request: PermissionRequestView; agent: string }) {
  const client = useClient();
  const [answered, setAnswered] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const answer = useAction((decision: PermissionDecision) =>
    client.answerPermission(request.id, decision).catch((err: unknown) => {
      // 404/409: answered in another window or the CLI, or withdrawn. The next refresh drops it (Review Focus 2).
      const status = (err as { status?: unknown }).status;
      if (status !== 404 && status !== 409) throw err;
      setAnswered(true);
    }),
  );
  const summary = toolInputSummary(request.tool, request.input);
  const disabled = answer.pending;

  return (
    <div
      style={{ background: "#fef3c7", padding: space.sm, borderRadius: radius.sm, margin: `${space.sm}px 0` }}
    >
      <div>
        <b>
          {request.tool === "Bash"
            ? `${agent} wants to run: ${summary}`
            : `${agent} wants to use ${displayText(request.tool)}: ${summary}`}
        </b>
      </div>
      {request.title && <div>{displayText(request.title)}</div>}
      {answered ? (
        <div>Already answered</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs, marginTop: space.xs }}>
          <button disabled={disabled} onClick={() => void answer.run({ allow: true })}>
            Allow
          </button>
          {request.canRemember && (
            <button disabled={disabled} onClick={() => void answer.run({ allow: true, remember: true })}>
              Always allow this session
            </button>
          )}
          {denying && (
            <input
              aria-label="Reason (optional)"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          <button
            disabled={disabled}
            onClick={() =>
              denying
                ? void answer.run(reason.trim() ? { allow: false, reason: reason.trim() } : { allow: false })
                : setDenying(true)
            }
          >
            Deny
          </button>
        </div>
      )}
      {answer.error && <p role="alert">{displayText(answer.error)}</p>}
    </div>
  );
}
