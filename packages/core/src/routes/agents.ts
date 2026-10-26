import type { AgentInfo } from "@coord/protocol";
import type { TaskRunner } from "../runner/task-runner";
import type { Routes } from "./types";

export const agentRoutes =
  (runner: TaskRunner): Routes =>
  async (api) => {
    api.get("/agents", async (): Promise<AgentInfo[]> => runner.agents());
  };
