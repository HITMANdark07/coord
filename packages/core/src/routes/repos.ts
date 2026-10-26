import { stat } from "node:fs/promises";
import { AddRepoInput, type Repo } from "@coord/protocol";
import { GitError, isNotARepoError, readRepoInfo } from "@coord/worktree-manager";
import type { Store } from "@coord/task-store";
import { RunnerError } from "../runner/errors";
import type { Routes } from "./types";

export const repoRoutes =
  (store: Store): Routes =>
  async (api) => {
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
      return reply.code(201).send(repo);
    });

    api.get<{ Params: { id: string } }>("/repos/:id", async (req) => {
      const repo = store.getRepo(req.params.id);
      if (!repo) throw new RunnerError("not_found", `repo ${req.params.id} not found`);
      return repo;
    });
  };
