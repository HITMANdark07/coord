import { stat } from "node:fs/promises";
import { z } from "zod";
import { CreateTaskInput, MessageInput, type DaemonEvent, type DiffView, type Task } from "@coord/protocol";
import type { Store } from "@coord/task-store";
import { diffAgainstBase, localBaseRef } from "@coord/worktree-manager";
import { RunnerError } from "../runner/errors";
import { toTask, type TaskRunner } from "../runner/task-runner";
import type { Routes } from "./types";

const Flag = z.enum(["1", "true", "0", "false"]).transform((v) => v === "1" || v === "true");
const ListQuery = z.object({ repoId: z.string().optional(), all: Flag.optional() });
const EventsQuery = z.object({ sinceSeq: z.coerce.number().int().min(0).optional() });
/** Hidden from the default list: the task is over (spec §5). */
const CLOSED = ["cancelled", "cleaned_up"] as const;
const ACTIONS = ["interrupt", "cancel", "discard", "resume"] as const;

export const taskRoutes =
  (store: Store, runner: TaskRunner): Routes =>
  async (api) => {
    const known = (id: string) => {
      const task = store.getTask(id);
      if (!task) throw new RunnerError("not_found", `task ${id} not found`);
      return task;
    };

    api.get("/tasks", async (req): Promise<Task[]> => {
      const { repoId, all } = ListQuery.parse(req.query);
      const tasks = store.listTasks(repoId === undefined ? {} : { repoId }).map(toTask);
      return all ? tasks : tasks.filter((t) => !(CLOSED as readonly string[]).includes(t.status));
    });

    api.post("/tasks", async (req, reply) => {
      const input = CreateTaskInput.parse(req.body);
      return reply.code(201).send(toTask(await runner.create(input)));
    });

    api.get<{ Params: { id: string } }>("/tasks/:id", async (req): Promise<Task> =>
      toTask(known(req.params.id)),
    );

    api.get<{ Params: { id: string } }>("/tasks/:id/events", async (req): Promise<DaemonEvent[]> => {
      const task = known(req.params.id);
      const { sinceSeq } = EventsQuery.parse(req.query);
      return store.listEvents({ taskId: task.id, ...(sinceSeq === undefined ? {} : { sinceSeq }) });
    });

    api.get<{ Params: { id: string } }>("/tasks/:id/diff", async (req): Promise<DiffView> => {
      const task = known(req.params.id);
      // No worktree: not set up yet, or discarded. A directory gone from disk: removed outside coord.
      const present =
        task.worktreePath !== null &&
        (await stat(task.worktreePath).then(
          (s) => s.isDirectory(),
          () => false,
        ));
      if (task.worktreePath === null || !present) {
        throw new RunnerError(
          "conflict",
          `task is ${task.status} and has no worktree on disk, so there is no diff`,
        );
      }
      // Read-only: never fetch here (a diff is polled while a human watches).
      const base = task.baseBranch ?? store.getRepo(task.repoId)?.defaultBranch ?? "main";
      return diffAgainstBase({
        cwd: task.worktreePath,
        baseRef: await localBaseRef(task.repoPath, base),
        // The env files Coord copied in hold secrets; a repo that doesn't ignore them would show them.
        exclude: task.envFiles,
      });
    });

    api.post<{ Params: { id: string } }>("/tasks/:id/messages", async (req): Promise<Task> => {
      const { text } = MessageInput.parse(req.body);
      return toTask(await runner.message(req.params.id, text));
    });

    for (const action of ACTIONS) {
      api.post<{ Params: { id: string } }>(`/tasks/:id/${action}`, async (req): Promise<Task> =>
        toTask(await runner[action](req.params.id)),
      );
    }
  };
