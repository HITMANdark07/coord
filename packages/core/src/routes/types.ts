import type { FastifyInstance } from "fastify";

/** A route group, registered inside the server's authenticated scope. */
export type Routes = (api: FastifyInstance) => Promise<void>;
