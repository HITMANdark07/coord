import type { CoordClient } from "@coord/client";

export const MIN_PREFIX = 4;

/** Resolves a full task id or a unique prefix (at least 4 characters) to a full id. */
export async function resolveTaskId(client: CoordClient, input: string): Promise<string> {
  const tasks = await client.listTasks({ all: true });
  if (tasks.some((t) => t.id === input)) return input;
  if (input.length < MIN_PREFIX) {
    throw new Error(`task id "${input}" is too short: give at least ${MIN_PREFIX} characters`);
  }
  const matches = tasks.filter((t) => t.id.startsWith(input));
  if (matches.length === 0) throw new Error(`no task matches "${input}"`);
  if (matches.length > 1) {
    const candidates = matches.map((t) => `  ${t.id}  ${t.title}`).join("\n");
    throw new Error(`"${input}" is ambiguous, it matches ${matches.length} tasks:\n${candidates}`);
  }
  return matches[0]!.id;
}
