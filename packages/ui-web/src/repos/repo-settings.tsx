import { useAction, useClient } from "@coord/app-state";
import { colors, fontSize } from "@coord/design-tokens";
import { displayText, type Repo } from "@coord/protocol";

export const BYPASS_WARNING =
  "Bypass runs every tool call without asking. Only use it for repos you'd let the agent change freely.";

export function RepoSettings({
  repo,
  surface,
  onClose,
}: {
  repo: Repo;
  surface: "desktop" | "web";
  onClose: () => void;
}) {
  const client = useClient();
  const update = useAction(client.updateRepo);
  return (
    <section aria-label="Repo settings">
      <h2 style={{ fontSize: fontSize.md }}>{displayText(repo.name)}</h2>
      <dl>
        <dt>Path</dt>
        <dd>{displayText(repo.path)}</dd>
        <dt>Default branch</dt>
        <dd>{displayText(repo.defaultBranch)}</dd>
        <dt>Remote</dt>
        <dd>{repo.remoteUrl ? displayText(repo.remoteUrl) : "none"}</dd>
      </dl>
      {/* Bypass can only be switched on from the desktop app (spec: never CLI, MCP or PWA). */}
      {surface === "desktop" && (
        <>
          <label>
            <input
              type="checkbox"
              checked={repo.bypassAllowed}
              disabled={update.pending}
              onChange={(e) => void update.run(repo.id, { bypassAllowed: e.target.checked })}
            />{" "}
            Allow bypass mode for this repo
          </label>
          <p style={{ color: colors.light.muted, fontSize: fontSize.sm }}>{BYPASS_WARNING}</p>
          {update.error && <p role="alert">{displayText(update.error)}</p>}
        </>
      )}
      <button onClick={onClose}>Close</button>
    </section>
  );
}
