import type { CoordClient } from "@coord/client";

export const MIN_PREFIX = 4;

/**
 * Resolves a full id or a unique prefix (at least 4 characters) among `items` to a full id.
 * `kind` names what is looked up in the errors ("task", "pending permission").
 */
export function resolveId(
  kind: string,
  items: ReadonlyArray<{ id: string; label: string }>,
  input: string,
): string {
  if (items.some((i) => i.id === input)) return input;
  if (input.length < MIN_PREFIX) {
    throw new Error(`${kind} id "${input}" is too short: give at least ${MIN_PREFIX} characters`);
  }
  const matches = items.filter((i) => i.id.startsWith(input));
  if (matches.length === 0) throw new Error(`no ${kind} matches "${input}"`);
  if (matches.length > 1) {
    const candidates = matches.map((i) => `  ${i.id}  ${i.label}`).join("\n");
    throw new Error(`"${input}" is ambiguous, it matches ${matches.length} ${kind}s:\n${candidates}`);
  }
  return matches[0]!.id;
}

/** Resolves a full task id or a unique prefix to a full id. */
export async function resolveTaskId(client: CoordClient, input: string): Promise<string> {
  const tasks = await client.listTasks({ all: true });
  return resolveId(
    "task",
    tasks.map((t) => ({ id: t.id, label: t.title })),
    input,
  );
}

/** Resolves a pending permission request's full id or unique prefix (`coord allow|deny`). */
export async function resolvePermissionId(client: CoordClient, input: string): Promise<string> {
  const pending = await client.listPermissions();
  return resolveId(
    "pending permission",
    pending.map((p) => ({ id: p.id, label: `${p.tool} (task ${p.taskId.slice(0, 8)})` })),
    input,
  );
}
