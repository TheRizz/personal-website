import type { PublishState } from "../apps/web/app/lib/publish/state";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import type { StubRequest, StubState } from "./github-stub/api";
import { githubStubPort } from "./github-stub-port";
import { BASE_URL } from "./helpers";

// Drives the local GitHub stub (e2e/github-stub.ts) through its control API, and calls the
// publishing API as the owner, for the publish specs and global setup (contract §12).

/** Must match the stub's own port (and GITHUB_API_BASE in the build's `.dev.vars`). */
export const STUB_URL = `http://127.0.0.1:${githubStubPort()}`;

export type { StubCommit, StubPull, StubRequest, StubState } from "./github-stub/api";

async function control<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${STUB_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub stub: ${method} ${path} -> ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/** The owner's moves on GitHub, and GitHub Actions' results, played on the stub. */
export const githubStub = {
  /** `main` back to the working tree's posts; no branches, PRs, runs or recorded requests. */
  reset: () => control<{ ok: true }>("POST", "/__stub/reset"),
  state: () => control<StubState>("GET", "/__stub/state"),
  /** Every request the build sent to the stub since the last reset, oldest first. */
  requests: () => control<StubRequest[]>("GET", "/__stub/requests"),
  /** Sets the `ci` check run of the PR's current head. */
  checks: (
    pr: number,
    status: "queued" | "in_progress" | "completed",
    conclusion?: "success" | "failure",
  ) =>
    control<{ head: string; runUrl: string }>("POST", `/__stub/pulls/${pr}/checks`, {
      status,
      ...(conclusion && { conclusion }),
    }),
  /** Squash and merge, as the owner does on GitHub; the branch is deleted. */
  merge: (pr: number) => control<{ mergeSha: string }>("POST", `/__stub/pulls/${pr}/merge`),
  /** Closes the PR without merging it, as the owner might on GitHub. */
  close: (pr: number) => control<{ ok: true }>("POST", `/__stub/pulls/${pr}/close`),
  /** Adds a `deploy.yml` push run for `sha`, newer than its earlier ones. */
  deploy: (
    sha: string,
    status: "queued" | "in_progress" | "completed",
    conclusion?: "success" | "failure" | "cancelled",
  ) =>
    control<{ runUrl: string }>("POST", `/__stub/deploys/${sha}`, {
      status,
      ...(conclusion && { conclusion }),
    }),
  /** The commit the site serves, as far as status checks can tell. */
  setVersion: (version: string) =>
    control<{ version: string }>("POST", "/__stub/version", { version }),
  /** Commits a change to a file on `main` directly (null deletes it). */
  setMainFile: (path: string, content: string | null) =>
    control<{ commit: string }>("POST", "/__stub/main/files", { path, content }),
};

/**
 * A request to the admin API as the owner, with the test token and, for a write, the headers the
 * admin fetch wrapper and the browser add to a same-origin request.
 */
export async function ownerFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    [ASSERTION_HEADER]: await signAccessToken(),
    "X-Requested-With": "XMLHttpRequest",
  };
  if (method !== "GET") {
    headers.Origin = new URL(BASE_URL).origin;
    headers["Sec-Fetch-Site"] = "same-origin";
    headers["X-Admin"] = "1";
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** `ownerFetch`, expecting `status`; returns the JSON body. */
export async function ownerJson<T>(
  method: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<T> {
  const response = await ownerFetch(method, path, body);
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`${method} ${path}: expected ${status}, got ${response.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

export interface DraftSummary {
  id: string;
  kind: string;
  slug: string | null;
  title: string;
  status: string;
}

export interface Draft extends DraftSummary {
  sourcePath: string | null;
  bodyMd: string;
  rev: number;
  prNumber: number | null;
  prAction: string | null;
}

export const listDrafts = async () =>
  (await ownerJson<{ drafts: DraftSummary[] }>("GET", "/api/admin/drafts")).drafts;

export const getDraft = (id: string) => ownerJson<Draft>("GET", `/api/admin/drafts/${id}`);

/** Creates a draft through the API and returns its id. */
export async function createDraft(fields: {
  title: string;
  summary?: string;
  tags?: string[];
  bodyMd?: string;
}): Promise<string> {
  const { id } = await ownerJson<{ id: string }>("POST", "/api/admin/drafts", fields, 201);
  return id;
}

/** The edit draft of the post `slug` on the stub's `main`, imported if it has none. */
export async function importPost(slug: string): Promise<string> {
  const response = await ownerFetch("POST", `/api/admin/posts/${slug}/import`, {});
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Importing ${slug} failed: ${response.status} ${text}`);
  }
  return (JSON.parse(text) as { id: string }).id;
}

export const publishState = (id: string) =>
  ownerJson<PublishState>("GET", `/api/admin/drafts/${id}/status`);

/** Today's date as the editor sends it (the Worker accepts ±1 day of its own UTC date). */
export const today = () => new Date().toISOString().slice(0, 10);

/** Publishes a draft through the API, as the editor's Publish now does. */
export async function publishDraft(id: string, slug?: string) {
  const { rev } = await getDraft(id);
  return ownerJson<PublishState & { republished: boolean }>(
    "POST",
    `/api/admin/drafts/${id}/publish`,
    { baseRev: rev, date: today(), ...(slug && { slug }) },
    202,
  );
}

const OPEN_STAGES = new Set(["opened", "ci_running", "ci_failed", "review"]);
const MERGED_STAGES = new Set(["merged", "deploying", "deploy_failed"]);

/**
 * Discards a draft, first settling its pull request: a merged one is made Live (the stub serves
 * its merge commit), an open one is cancelled. Discard is refused while a PR is under way.
 */
export async function discardDraft(id: string): Promise<void> {
  try {
    let state = await publishState(id);
    if (MERGED_STAGES.has(state.stage) && state.mergeSha) {
      await githubStub.setVersion(state.mergeSha);
      state = await publishState(id);
    }
    if (OPEN_STAGES.has(state.stage)) {
      await ownerJson("POST", `/api/admin/drafts/${id}/cancel`, {});
    }
  } catch {
    // The discard below says whether the draft is still stuck.
  }
  const response = await ownerFetch("DELETE", `/api/admin/drafts/${id}`);
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Couldn't discard an e2e draft: ${response.status} ${await response.text()}`);
  }
}

/**
 * Resets the stub and discards the drafts the e2e tests make: titled "E2E …", or the draft of the
 * stub's `hello-world` post. Run by global setup and before every publish test.
 */
export async function cleanUpDrafts(): Promise<void> {
  await githubStub.reset();
  for (const draft of await listDrafts()) {
    if (draft.title.startsWith("E2E ") || draft.slug === "hello-world") {
      await discardDraft(draft.id);
    }
  }
}

const unescape = (text: string) =>
  text
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\/g, "")
    .toLowerCase();

/**
 * One line per recorded request whose path or body holds one of `values`, ignoring case, `\`
 * escapes and percent-encoding. Empty when none does.
 */
export function mentions(requests: StubRequest[], values: string[]): string[] {
  const problems: string[] = [];
  for (const request of requests) {
    const text = unescape(`${request.path}\n${request.body ?? ""}`);
    values.forEach((value, index) => {
      if (text.includes(unescape(value))) {
        const where = request.operationName ?? request.path.split("?")[0];
        problems.push(`${request.method} ${where} holds value #${index}`);
      }
    });
  }
  return problems;
}
