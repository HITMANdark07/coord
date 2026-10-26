import { AddRepoInput, type Repo } from "@coord/protocol";
import { GitError, readRepoInfo } from "@coord/worktree-manager";
import type { Store } from "@coord/task-store";
import { RunnerError } from "../runner/errors";
import type { Routes } from "./types";

export const repoRoutes =
  (store: Store): Routes =>
  async (api) => {
    api.get("/repos", async (): Promise<Repo[]> => store.listRepos());

    api.post("/repos", async (req, reply) => {
      const { path } = AddRepoInput.parse(req.body);
      let info: Awaited<ReturnType<typeof readRepoInfo>>;
      try {
        info = await readRepoInfo(path);
      } catch (e) {
        // A missing directory surfaces as an ENOENT from spawn, a non-repo as a git failure.
        if (e instanceof GitError || (e as { code?: string }).code === "ENOENT") {
          throw new RunnerError("invalid_request", `not a git repository: ${path}`);
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
