import { z } from "zod";

/** An agent the New task form can offer: `available` when the daemon has its adapter. */
export const AgentInfo = z.object({
  id: z.string(),
  available: z.boolean(),
  costReporting: z.boolean(),
  liveMessages: z.boolean(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;
