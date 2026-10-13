// What the GitHub stub (e2e/github-stub.ts) and the code that drives it share: the test App's
// key file, and the JSON shapes of the control API (contract §11).

/** The test GitHub App, written by `pnpm e2e:keys`; the stub verifies App JWTs with its key. */
export interface TestGitHubApp {
  clientId: string;
  installationId: string;
  privateKeyPkcs8Pem: string;
  publicKeySpkiPem: string;
}

/** Gitignored, like the Access test identity next to it. */
export const GITHUB_APP_FILE = new URL("../.auth/github-app.json", import.meta.url);

/** One request the stub received, other than the control API. */
export interface StubRequest {
  method: string;
  /** Path and query, as sent. */
  path: string;
  /** The GraphQL operation, for `POST /graphql`. */
  operationName?: string;
  /** The raw request body, or null. */
  body: string | null;
}

export interface StubPerson {
  name: string;
  email: string;
}

export interface StubCommit {
  sha: string;
  parents: string[];
  message: string;
  author: StubPerson | null;
  committer: StubPerson | null;
  /** Every file path in the commit's tree. */
  paths: string[];
}

export interface StubPull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  /** `main` when the PR was opened. */
  baseSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  comments: string[];
  /** The commits on the PR's branch that `main` didn't have, oldest first. */
  commits: StubCommit[];
}

/** `GET /__stub/state`. */
export interface StubState {
  /** The version `GET /__e2e/health` reports as live. */
  version: string;
  /** Branch → commit SHA, `main` included. */
  refs: Record<string, string>;
  /** Every file path on `main`. */
  mainPaths: string[];
  pulls: StubPull[];
  /** Requests outside the allowlist, merge endpoints and GraphQL mutations, as `METHOD path`. */
  violations: string[];
}
