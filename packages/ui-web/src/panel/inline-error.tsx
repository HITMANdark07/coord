import { fontSize, statusColors } from "@coord/design-tokens";
import { displayText } from "@coord/protocol";

/** A failed action's message, next to the button that ran it. */
export const InlineError = ({ error }: { error: string | null }) =>
  error && (
    <span role="alert" style={{ color: statusColors.failed, fontSize: fontSize.sm }}>
      {displayText(error)}
    </span>
  );
