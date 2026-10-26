import { z } from "zod";
import { PermissionDecision, type PermissionRequestView } from "@coord/protocol";
import { RunnerError } from "../runner/errors";
import type { PermissionBroker } from "../permission-broker";
import type { Routes } from "./types";

const Query = z.object({ taskId: z.string().optional() });

export const permissionRoutes =
  (broker: PermissionBroker): Routes =>
  async (api) => {
    api.get("/permissions", async (req): Promise<PermissionRequestView[]> => {
      // Validated: a repeated key would arrive as an array and crash the SQL binding.
      const { taskId } = Query.parse(req.query);
      return broker.pending(taskId);
    });

    api.post<{ Params: { id: string } }>("/permissions/:id", async (req, reply) => {
      const decision = PermissionDecision.parse(req.body);
      const outcome = broker.answer(req.params.id, decision);
      if (outcome === "not_found")
        throw new RunnerError("not_found", `permission ${req.params.id} not found`);
      if (outcome === "already_resolved") throw new RunnerError("conflict", "permission already answered");
      return reply.code(204).send();
    });
  };
