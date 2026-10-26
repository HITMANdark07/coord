import { useState } from "react";
import { useAction, useClient } from "@coord/app-state";
import { displayText, type Repo } from "@coord/protocol";
import type { AppPlatform } from "../app";

/** Desktop opens the OS folder picker; the PWA can't see the daemon's disk, so it asks for a path. */
export function AddRepo({
  platform,
  onAdded,
}: {
  platform: AppPlatform | undefined;
  onAdded: (repo: Repo) => void;
}) {
  const client = useClient();
  const [path, setPath] = useState("");
  const pickFolder = platform?.pickFolder;
  const add = useAction(async (chosen?: string) => {
    const target = chosen ?? (await pickFolder?.());
    if (!target) return; // picker cancelled
    onAdded(await client.addRepo(target));
    setPath("");
  });

  return (
    <div>
      {pickFolder ? (
        <button disabled={add.pending} onClick={() => void add.run()}>
          Add repo
        </button>
      ) : (
        <>
          <input
            aria-label="Repo path"
            placeholder="/path/to/repo"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />{" "}
          <button disabled={add.pending || !path.trim()} onClick={() => void add.run(path.trim())}>
            Add
          </button>
        </>
      )}
      {add.error && <p role="alert">{displayText(add.error)}</p>}
    </div>
  );
}
