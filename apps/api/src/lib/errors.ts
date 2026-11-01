/** Error with an HTTP status and an optional exact setup requirement for the UI. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requirement: string | null = null,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new ApiProblem(404, "not_found", what);
export const forbidden = (msg = "You don't have access to this") => new ApiProblem(403, "forbidden", msg);
export const unauthorized = (msg = "Sign in first") => new ApiProblem(401, "unauthorized", msg);
export const badRequest = (msg: string, requirement: string | null = null) => new ApiProblem(400, "bad_request", msg, requirement);
export const unavailable = (msg: string, requirement: string | null) => new ApiProblem(503, "unavailable", msg, requirement);
export const conflict = (msg: string, requirement: string | null = null) => new ApiProblem(409, "conflict", msg, requirement);
