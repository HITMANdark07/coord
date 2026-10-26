import { stat } from "node:fs/promises";
import { AddRepoInput, UpdateRepoInput, type Repo, type RepoConfigView } from "@coord/protocol";
import {
  detectSetupCommands,
  GitError,
  isNotARepoError,
  localBaseRef,
  readRepoInfo,
} from "@coord/worktree-manager";
import type { Store } from "@coord/task-store";
import { RunnerError } from "../runner/errors";
import { resolveBase, type TaskRunner } from "../runner/task-runner";
import type { Routes } from "./types";

export const repoRoutes =
  (store: Store, runner: TaskRunner): Routes =>
  async (api) => {
    const known = (id: string) => {
      const repo = store.getRepo(id);
      if (!repo) throw new RunnerError("not_found", `repo ${id} not found`);
      return repo;
    };

    api.get("/repos", async (): Promise<Repo[]> => store.listRepos());

    api.post("/repos", async (req, reply) => {
      const { path } = AddRepoInput.parse(req.body);
      const isDir = await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isDir) throw new RunnerError("invalid_request", `not a git repository: ${path}`);
      let info: Awaited<ReturnType<typeof readRepoInfo>>;
      try {
        info = await readRepoInfo(path);
      } catch (e) {
        if (e instanceof GitError) {
          // Exit code -1 means git never ran (not installed, not on PATH): the daemon's problem,
          // not the caller's, so 503 rather than a misleading "not a git repository".
          if (e.exitCode === -1) throw new RunnerError("unavailable", "git is not available to the daemon");
          if (isNotARepoError(e)) throw new RunnerError("invalid_request", `not a git repository: ${path}`);
          throw new RunnerError("internal", `git failed for ${path}: ${e.stderr.trim() || e.message}`);
        }
        throw e;
      }
      // Register git's canonical top level, so symlinks, `..` and subdirectories of one repo
      // can't create duplicate registrations.
      const repo = store.addRepo({
        name: info.name,
        path: info.root,
        defaultBranch: info.defaultBranch,
        remoteUrl: info.remoteUrl,
      });
      runner.repoUpdated(repo);
      return reply.code(201).send(repo);
    });

    api.get<{ Params: { id: string } }>("/repos/:id", async (req): Promise<Repo> => known(req.params.id));

    api.patch<{ Params: { id: string } }>("/repos/:id", async (req): Promise<Repo> => {
      const { bypassAllowed } = UpdateRepoInput.parse(req.body);
      const repo = store.setRepoBypass(known(req.params.id).id, bypassAllowed);
      runner.repoUpdated(repo);
      return repo;
    });

    api.get<{ Params: { id: string } }>("/repos/:id/config", async (req): Promise<RepoConfigView> => {
      const repo = known(req.params.id);
      // Read-only: never fetch here (the New task form loads it while a human waits).
      const { baseBranch, config } = await resolveBase(repo, null, localBaseRef).catch((e: unknown) => {
        // A broken config or a missing base branch: the repo's state, which the user can fix.
        throw new RunnerError("conflict", e instanceof Error ? e.message : String(e));
      });
      if (config.setup) return { baseBranch, config, setup: config.setup, setupSource: "config" };
      // shortcut: detects from the main checkout, not the base ref; read the ref's lockfiles if they differ.
      return { baseBranch, config, setup: await detectSetupCommands(repo.path), setupSource: "detected" };
    });
  };
