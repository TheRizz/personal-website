import { GitHubError, type GitHubEnv } from "./github";

// Responses for the publishing API (design doc §4.9.2): the `/api` error shape, with extra fields
// beside `error` where the editor needs them (`{rev}`, `{sha}`, `{srcs}`), and never cached.

/** The bindings the publishing routes use. */
export type PublishEnv = Pick<Env, "DB"> & GitHubEnv;

const noStore = { "Cache-Control": "no-store" };

/** `{ error: { code, message }, ...extra }` with `status`. */
export function publishError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: { code, message }, ...extra }, { status, headers: noStore });
}

/** A successful answer. */
export function publishJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

/**
 * A refusal raised deep inside a flow. The router answers with its response; a flow that has
 * already pushed a branch closes the PR and deletes the branch first, as for any other error.
 */
export class Refusal extends Error {
  constructor(readonly response: Response) {
    super("refused");
    this.name = "Refusal";
  }
}

/** `publishError` as something to throw. */
export function refuse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Refusal {
  return new Refusal(publishError(status, code, message, extra));
}

/**
 * Logs a failure by kind only: the error class, and for GitHub the route template and status.
 * Never a message, which could hold a path, a slug or a database value.
 */
export function logPublishingError(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const operation = error instanceof GitHubError ? error.operation : "";
  const status = error instanceof GitHubError ? error.status : "";
  console.error("Publishing failed:", name, operation, status);
}
