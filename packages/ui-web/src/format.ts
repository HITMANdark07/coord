import { displayText, type Task } from "@coord/protocol";

const AGENT_LABELS: Record<string, string> = { "claude-code": "Claude", codex: "Codex" };

export const agentLabel = (agent: string) => AGENT_LABELS[agent] ?? displayText(agent);

export function formatElapsed(fromIso: string, to: string | Date): string {
  const seconds = Math.max(0, Math.floor((new Date(to).getTime() - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** Agents that don't report cost (Codex…) show tokens instead, so the card never shows a fake $0.00. */
export function formatUsage(task: Task, costReporting: boolean): string {
  if (costReporting) return `$${task.costUsd.toFixed(2)}`;
  const tokens = task.inputTokens + task.outputTokens;
  return tokens < 1000 ? `${tokens} tok` : `${Math.round(tokens / 1000)}k tok`;
}
