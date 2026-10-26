import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { usePermissions, useTaskEvents } from "@coord/app-state";
import { colors, fontSize, space, statusColors } from "@coord/design-tokens";
import { displayText, type Task } from "@coord/protocol";
import { agentLabel } from "../format";
import { liveRows, type LiveRow } from "./live-rows";
import { MessageBox } from "./message-box";
import { PermissionPrompt } from "./permission-prompt";

const c = colors.light;
const ROW_STYLE: Record<LiveRow["kind"], CSSProperties> = {
  text: {},
  tool: { fontFamily: "ui-monospace, monospace" },
  result: { fontFamily: "ui-monospace, monospace", color: statusColors.failed },
  turn: { color: c.muted },
  error: { color: statusColors.failed },
  status: { color: c.muted, fontSize: fontSize.sm },
};

export function LiveTab({ task }: { task: Task }) {
  const events = useTaskEvents(task.id);
  const permissions = usePermissions(task.id);
  const rows = useMemo(() => liveRows(events.events), [events.events]);
  const prompts = permissions.status === "loading" ? [] : (permissions.data ?? []);

  // Follow new rows only while the user is at the bottom; scrolling up to read stops it.
  const stream = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = stream.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        ref={stream}
        role="log"
        aria-label="Live stream"
        style={{ flex: 1, overflowY: "auto", lineHeight: 1.7, paddingBottom: space.sm }}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {events.status === "error" && events.error && (
          <p role="alert">Could not load the stream: {displayText(events.error)}</p>
        )}
        {rows.map((row) => (
          <div
            key={row.key}
            style={{
              ...ROW_STYLE[row.kind],
              paddingLeft: row.depth * space.lg,
              // Agent text is often several lines (lists, code); long paths must not widen the panel.
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {row.text}
          </div>
        ))}
        {prompts.map((p) => (
          <PermissionPrompt key={p.id} request={p} agent={agentLabel(task.agent)} />
        ))}
      </div>
      <MessageBox task={task} />
    </div>
  );
}
