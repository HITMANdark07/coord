import { z } from "zod";
import {
  AddRepoInput,
  CreateTaskInput,
  DaemonEvent,
  DiffView,
  Health,
  MessageInput,
  PermissionDecision,
  PermissionRequestView,
  Repo,
  Task,
} from "@coord/protocol";
import { httpTransport, type ConnectionStatus, type Transport } from "./transport";

export interface DaemonEventListener {
  onEvent?(event: DaemonEvent): void;
  onStatus?(status: ConnectionStatus): void;
}

/** Typed daemon API. Every response and pushed event is validated against the protocol schemas. */
export function createClient(transport: Transport = httpTransport()) {
  const get = (path: string) => transport.request({ method: "GET", path });
  const post = (path: string, body?: unknown) =>
    transport.request({ method: "POST", path, ...(body === undefined ? {} : { body }) });
  const seg = encodeURIComponent;
  const query = (params: Record<string, string | undefined>) => {
    const parts = Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${seg(v)}`]));
    return parts.length ? `?${parts.join("&")}` : "";
  };
  const tasks = z.array(Task);
  const taskAction = async (id: string, action: string) =>
    Task.parse(await post(`/tasks/${seg(id)}/${action}`));

  // One upstream event connection per client, shared by every subscriber (each hook would
  // otherwise open its own socket, and over the relay each socket is a separate peer).
  const listeners = new Set<DaemonEventListener>();
  let closeUpstream: (() => void) | undefined;
  let status: ConnectionStatus = "closed";

  function subscribe(listener: DaemonEventListener): () => void {
    listeners.add(listener);
    if (!closeUpstream) {
      closeUpstream = transport.subscribe({
        onEvent: (raw) => {
          const event = DaemonEvent.safeParse(raw);
          if (event.success) for (const l of listeners) l.onEvent?.(event.data);
        },
        onStatus: (next) => {
          status = next;
          for (const l of listeners) l.onStatus?.(next);
        },
      });
    } else if (status === "open") {
      listener.onStatus?.("open");
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        closeUpstream?.();
        closeUpstream = undefined;
        status = "closed";
      }
    };
  }

  return {
    health: async () => Health.parse(await get("/health")),
    listRepos: async () => z.array(Repo).parse(await get("/repos")),
    addRepo: async (path: string) => Repo.parse(await post("/repos", AddRepoInput.parse({ path }))),
    listTasks: async (filter: { repoId?: string; all?: boolean } = {}) =>
      tasks.parse(await get(`/tasks${query({ repoId: filter.repoId, all: filter.all ? "1" : undefined })}`)),
    getTask: async (id: string) => Task.parse(await get(`/tasks/${seg(id)}`)),
    createTask: async (input: CreateTaskInput) =>
      Task.parse(await post("/tasks", CreateTaskInput.parse(input))),
    taskEvents: async (id: string, sinceSeq?: number) =>
      z
        .array(DaemonEvent)
        .parse(await get(`/tasks/${seg(id)}/events${query({ sinceSeq: sinceSeq?.toString() })}`)),
    taskDiff: async (id: string) => DiffView.parse(await get(`/tasks/${seg(id)}/diff`)),
    sendMessage: async (id: string, text: string) =>
      Task.parse(await post(`/tasks/${seg(id)}/messages`, MessageInput.parse({ text }))),
    interrupt: (id: string) => taskAction(id, "interrupt"),
    cancel: (id: string) => taskAction(id, "cancel"),
    discard: (id: string) => taskAction(id, "discard"),
    resumeTask: (id: string) => taskAction(id, "resume"),
    listPermissions: async (taskId?: string) =>
      z.array(PermissionRequestView).parse(await get(`/permissions${query({ taskId })}`)),
    /** Resolves when the daemon accepted the answer (204). Rejects with `conflict` if it was already answered. */
    answerPermission: async (id: string, decision: PermissionDecision): Promise<void> => {
      await post(`/permissions/${seg(id)}`, PermissionDecision.parse(decision));
    },
    /** Live daemon events and connection status. Frames that don't match the protocol are dropped. */
    subscribe,
  };
}

export type CoordClient = ReturnType<typeof createClient>;
