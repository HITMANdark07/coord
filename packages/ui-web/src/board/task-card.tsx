import { colors, fontSize, radius, space, statusColors } from "@coord/design-tokens";
import { displayText, type Task } from "@coord/protocol";
import { agentLabel, formatElapsed, formatUsage } from "../format";

const c = colors.light;
// Finished tasks stop their clock at the last update.
const ACTIVE = ["queued", "setting_up", "running", "checking", "needs_input"];

/** `detail` is what the user must act on; only set for cards in the Needs you column. */
export function TaskCard({
  task,
  now,
  costReporting,
  detail,
  onOpen,
}: {
  task: Task;
  now: Date;
  costReporting: boolean;
  detail?: string | undefined;
  onOpen: (id: string) => void;
}) {
  const end = ACTIVE.includes(task.status) || !task.updatedAt ? now : task.updatedAt;
  const needsYou = detail !== undefined;
  return (
    <button
      onClick={() => onOpen(task.id)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        font: "inherit",
        color: c.text,
        cursor: "pointer",
        background: needsYou ? "#fef3c7" : c.surface,
        border: `${needsYou ? 2 : 1}px solid ${needsYou ? statusColors[task.status] : c.border}`,
        borderRadius: radius.md,
        padding: space.sm,
        marginBottom: space.sm,
      }}
    >
      {/* The marker, not just the colour, says this needs you. */}
      <div>
        {needsYou ? "⚠ " : ""}
        {displayText(task.title)}
      </div>
      <div style={{ color: c.muted, fontSize: fontSize.sm }}>
        <span>{agentLabel(task.agent)}</span> · {formatElapsed(task.createdAt, end)} ·{" "}
        {formatUsage(task, costReporting)}
      </div>
      {needsYou && <div style={{ fontSize: fontSize.sm }}>{detail}</div>}
    </button>
  );
}
