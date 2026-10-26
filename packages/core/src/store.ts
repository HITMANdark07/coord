import { randomUUID } from "node:crypto";
import { CreateTaskInput, type Task } from "@coord/protocol";
import type { EventBus } from "./event-bus";

// In-memory for the skeleton; Phase 1 moves this to SQLite (PRD §8 Persistence).
export class TaskStore {
  private tasks = new Map<string, Task>();

  constructor(private readonly bus: EventBus) {}

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  create(raw: unknown): Task {
    const input = CreateTaskInput.parse(raw);
    const task: Task = {
      id: randomUUID(),
      // The repo registry (Phase 1) resolves repoId to a path; until then the skeleton keeps what it was given.
      repoId: input.repoId ?? "",
      repoPath: input.repoPath ?? "",
      title: input.title ?? input.prompt.slice(0, 60),
      prompt: input.prompt,
      agent: input.agent,
      status: "queued",
      branch: null,
      baseBranch: input.baseBranch ?? null,
      model: input.model ?? null,
      permissionMode: input.permissionMode,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      error: null,
      worktreePath: null,
      sessionId: null,
      costUsd: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    this.bus.publish({ kind: "task.updated", task });
    return task;
  }
}
