import { randomUUID } from "node:crypto";
import { CreateTaskInput, type Task } from "@wto/protocol";
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
      repoPath: input.repoPath,
      title: input.title ?? input.prompt.slice(0, 60),
      prompt: input.prompt,
      agent: input.agent,
      status: "queued",
      branch: null,
      worktreePath: null,
      sessionId: null,
      costUsd: 0,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    this.bus.publish({ kind: "task.updated", task });
    return task;
  }
}
