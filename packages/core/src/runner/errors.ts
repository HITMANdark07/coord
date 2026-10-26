import type { ErrorCode } from "@coord/protocol";

/** HTTP status for each error code, so routes can answer with one `ErrorBody` shape (AGENTS.md rule 3). */
const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  protocol_mismatch: 426,
  internal: 500,
  unavailable: 503,
};

/** A runner action the caller can't have: the route layer turns it into `ErrorBody { code, message }`. */
export class RunnerError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
    this.status = HTTP_STATUS[code];
  }
}
