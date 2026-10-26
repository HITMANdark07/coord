import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useAction, useAgents, useClient, useRepoConfig, useRepos } from "@coord/app-state";
import { colors, fontSize, radius, space } from "@coord/design-tokens";
import { branchSuggestion, CreateTaskInput, displayText, type PermissionMode } from "@coord/protocol";
import { BYPASS_WARNING } from "../repos/repo-settings";
import { useFocusWhileOpen } from "../use-focus-while-open";

const c = colors.light;
// The only agents the form offers (controller ruling); each is disabled when /agents says it's missing.
const AGENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;

const field: CSSProperties = { display: "block", marginBottom: space.md };
const wide: CSSProperties = { display: "block", width: "100%", boxSizing: "border-box" };

export function NewTaskForm({
  repoId,
  surface,
  onCreated,
  onClose,
}: {
  repoId: string | null;
  surface: "desktop" | "web";
  onCreated: (taskId: string) => void;
  onClose: () => void;
}) {
  const client = useClient();
  const repos = useRepos();
  const list = repos.status === "loading" ? [] : (repos.data ?? []);
  const [chosenRepo, setChosenRepo] = useState(repoId);
  const repo = list.find((r) => r.id === chosenRepo) ?? list.find((r) => r.id === repoId) ?? list[0];
  const config = useRepoConfig(repo?.id ?? null);
  const configView = config?.status === "ok" ? config.data : undefined;
  const agents = useAgents();

  const [prompt, setPrompt] = useState("");
  const promptField = useRef<HTMLTextAreaElement>(null);
  useFocusWhileOpen(promptField);
  const [agent, setAgent] = useState<(typeof AGENTS)[number]["id"]>("claude-code");
  const [model, setModel] = useState("");
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [baseEdit, setBaseEdit] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  const suggestion = branchSuggestion(prompt);
  const branch = branchEdit ?? suggestion;
  // After a 409 the daemon fetches at task start, so the field starts empty and is sent only if typed.
  const defaultBase = configView?.baseBranch ?? "";
  const base = baseEdit ?? defaultBase;
  const canBypass = surface === "desktop" && repo?.bypassAllowed === true;
  // A hidden Bypass choice (repo switched, opt-in revoked) must never be sent.
  const effectiveMode = mode === "bypass" && !canBypass ? "ask" : mode;
  const canSubmit = prompt.trim() !== "" && repo !== undefined;

  const create = useAction(async () => {
    if (!repo) return;
    const input = {
      repoId: repo.id,
      prompt,
      agent,
      permissionMode: effectiveMode,
      // Only what the user changed, so the daemon's own defaults (and uniqueBranch) still apply.
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(branch !== suggestion ? { branch } : {}),
      ...(base !== defaultBase && base !== "" ? { baseBranch: base } : {}),
    };
    // Reuse the protocol's branch rule instead of copying its regex.
    const branchIssue = CreateTaskInput.safeParse(input).error?.issues.find((i) => i.path[0] === "branch");
    setBranchError(branchIssue ? "Branch must start with agent/ and use only a-z, 0-9, . _ / -" : null);
    if (branchIssue) return;
    onCreated((await client.createTask(input)).id);
  });

  const submit = () => {
    if (canSubmit && !create.pending) void create.run();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      submit();
    } else if (e.target instanceof HTMLInputElement) {
      e.preventDefault(); // a stray Enter in a single-line field must not start a task
    }
  };

  return (
    <form
      aria-label="New task"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: radius.md,
        background: c.surface,
        padding: space.lg,
        maxWidth: 560,
        marginBottom: space.lg,
        fontSize: fontSize.sm,
      }}
    >
      <h2 style={{ fontSize: fontSize.lg, margin: `0 0 ${space.md}px` }}>New task</h2>
      <label style={field}>
        Repo
        <select
          style={wide}
          value={repo?.id ?? ""}
          onChange={(e) => {
            setChosenRepo(e.target.value);
            setBaseEdit(null);
            setMode("ask");
          }}
        >
          {list.map((r) => (
            <option key={r.id} value={r.id}>
              {displayText(r.name)}
            </option>
          ))}
        </select>
      </label>
      {repo && (
        <p style={{ color: c.muted, margin: `0 0 ${space.md}px` }}>
          {configView
            ? `${displayText(repo.path)} · base ${displayText(configView.baseBranch)}`
            : displayText(repo.path)}
        </p>
      )}
      {config?.status === "error" && <p role="alert">{displayText(config.error)}</p>}
      <label style={field}>
        What should the agent do?
        <textarea
          ref={promptField}
          style={wide}
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <fieldset style={{ ...field, border: 0, padding: 0 }}>
        <legend>Agent</legend>
        {AGENTS.map(({ id, label }) => {
          const info = agents.status === "ok" ? agents.data.find((a) => a.id === id) : undefined;
          const missing = agents.status === "ok" && !info?.available;
          return (
            <label key={id} style={{ marginRight: space.md }}>
              <input
                type="radio"
                name="agent"
                checked={agent === id}
                disabled={missing}
                onChange={() => setAgent(id)}
              />
              {missing ? `${label} (not installed)` : label}
            </label>
          );
        })}
      </fieldset>
      <label style={field}>
        Model
        <input
          style={wide}
          value={model}
          placeholder="Default (the agent's own setting)"
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      <label style={field}>
        Branch
        <input
          style={wide}
          value={branch}
          onChange={(e) => {
            setBranchEdit(e.target.value === "" ? null : e.target.value);
            setBranchError(null);
          }}
        />
      </label>
      {branchError && <p role="alert">{branchError}</p>}
      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
        style={{ ...field, border: 0, background: "none", padding: 0, color: c.muted, cursor: "pointer" }}
      >
        {advanced ? "▾" : "▸"} Advanced: permission mode · base branch · setup script
      </button>
      {advanced && (
        <div style={{ marginBottom: space.md }}>
          <fieldset style={{ ...field, border: 0, padding: 0 }}>
            <legend>Permission mode</legend>
            <label>
              <input
                type="radio"
                name="mode"
                checked={effectiveMode === "ask"}
                onChange={() => setMode("ask")}
              />
              Ask (default)
            </label>{" "}
            <label>
              <input
                type="radio"
                name="mode"
                checked={effectiveMode === "accept_edits"}
                onChange={() => setMode("accept_edits")}
              />
              Auto-accept edits
            </label>
            {canBypass && (
              <>
                {" "}
                <label>
                  <input
                    type="radio"
                    name="mode"
                    checked={effectiveMode === "bypass"}
                    onChange={() => setMode("bypass")}
                  />
                  Bypass
                </label>
                <p style={{ color: c.muted, margin: `${space.xs}px 0 0` }}>{BYPASS_WARNING}</p>
              </>
            )}
          </fieldset>
          <label style={field}>
            Base branch
            <input style={wide} value={base} onChange={(e) => setBaseEdit(e.target.value)} />
          </label>
          {configView && (
            <div>
              Setup script (from{" "}
              {configView.setupSource === "config" ? <code>.coord/config.json</code> : "detected"})
              <ul style={{ margin: `${space.xs}px 0` }}>
                {configView.setup.map((cmd) => (
                  <li key={cmd}>
                    <code>{displayText(cmd)}</code>
                  </li>
                ))}
              </ul>
              <span style={{ color: c.muted }}>
                Change it in <code>.coord/config.json</code> on the base branch.
              </span>
            </div>
          )}
        </div>
      )}
      {create.error && <p role="alert">{displayText(create.error)}</p>}
      <button type="submit" disabled={create.pending || !canSubmit}>
        Start task
      </button>{" "}
      <span style={{ color: c.muted }}>⌘↵</span>{" "}
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </form>
  );
}
