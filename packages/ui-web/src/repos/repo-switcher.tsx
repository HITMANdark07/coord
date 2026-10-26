import { useState } from "react";
import { displayText, type Repo } from "@coord/protocol";
import type { AppPlatform } from "../app";
import { AddRepo } from "./add-repo";
import { RepoSettings } from "./repo-settings";

const KEY = "coord.repo";

// A private window can throw on any storage access, so the selection then just lasts the session.
function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The selected repo; an unknown or missing stored id falls back to the first repo. */
export function useSelectedRepo(repos: Repo[]) {
  const [id, setId] = useState<string | null>(readStored);
  const selected = repos.find((r) => r.id === id) ?? repos[0];
  const select = (next: string) => {
    setId(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // not remembered; fine
    }
  };
  return [selected, select] as const;
}

export function RepoSwitcher({
  repos,
  selected,
  onSelect,
  surface,
  platform,
}: {
  repos: Repo[];
  selected: Repo;
  onSelect: (id: string) => void;
  surface: "desktop" | "web";
  platform: AppPlatform | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  return (
    <div>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {displayText(selected.name)} ▾
      </button>
      {open && (
        <div>
          {repos.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                onSelect(r.id);
                setOpen(false);
              }}
            >
              {displayText(r.name)}
            </button>
          ))}
          <button
            onClick={() => {
              setSettings(true);
              setOpen(false);
            }}
          >
            Repo settings
          </button>
          <AddRepo
            platform={platform}
            onAdded={(repo) => {
              onSelect(repo.id);
              setOpen(false);
            }}
          />
        </div>
      )}
      {settings && <RepoSettings repo={selected} surface={surface} onClose={() => setSettings(false)} />}
    </div>
  );
}
