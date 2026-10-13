import { verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  GITHUB_APP_FILE,
  type StubCommit,
  type StubRequest,
  type StubState,
  type TestGitHubApp,
} from "./github-stub/api";
import { GitRepo, type Person } from "./github-stub/git";
import { githubStubPort } from "./github-stub-port";

// A local GitHub for the e2e tests (design doc §4.9.9, contract §11.3). The build's `.dev.vars`
// points GITHUB_API_BASE here, so every publish, status poll and posts listing the Worker makes
// lands in this in-memory repository instead of on github.com. It answers only the routes the
// Worker's client may call: anything else is 501, and a merge endpoint or a GraphQL mutation is
// 500; each is kept as a violation the specs check for. The control API under /__stub/ plays the
// owner and GitHub Actions: CI results, Squash and merge, closing a PR, deploys, the live version.
// As on GitHub, a PR's head lags a push to its branch: the next read of the PR still shows the old
// one. The control API acts later, once the PR has caught up.
// Run it with `pnpm exec tsx e2e/github-stub.ts`; Playwright starts it before the preview.

const REPO = "TheRizz/personal-website";
const REPO_PATH = `/repos/${REPO}`;
const RUNS_URL = `https://github.com/${REPO}/actions/runs`;
const APP_SLUG = "e2e-publisher";
const BOT_ID = 4242;
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The only token request the Worker may make: this repository, the four permissions it uses. */
const TOKEN_REQUEST = {
  repositories: ["personal-website"],
  permissions: { contents: "write", pull_requests: "write", actions: "read", checks: "read" },
};
const QUERIES = new Set(["PostsTree", "PostsOnMain", "OpenPullHeads", "PublishStatus"]);
const BLOG_DIR = new URL("../content/blog/", import.meta.url);

type Json = Record<string, unknown>;

interface Pull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  comments: string[];
}

interface CheckRun {
  createdAt: string;
  status: string;
  conclusion: string | null;
  runId: number;
}

interface DeployRun {
  id: number;
  status: string;
  conclusion: string | null;
}

/** Everything a reset puts back. Issued tokens and the PR and run numbers outlive it. */
interface State {
  repo: GitRepo;
  pulls: Map<number, Pull>;
  /** PR number → the head its branch moved to, which the PR shows after its next read. */
  pendingHeads: Map<number, string>;
  /** The `ci` run of each head commit (one GitHub Actions suite). */
  checks: Map<string, CheckRun>;
  /** `deploy.yml` runs per commit, newest first. */
  deploys: Map<string, DeployRun[]>;
  version: string;
  requests: StubRequest[];
  violations: string[];
}

/** The posts in the working tree: `main` starts with them. */
function workingTreePosts(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(BLOG_DIR).sort()) {
    if (name.endsWith(".md")) {
      files.set(`content/blog/${name}`, readFileSync(new URL(name, BLOG_DIR), "utf8"));
    }
  }
  return files;
}

function freshState(): State {
  return {
    repo: new GitRepo(workingTreePosts()),
    pulls: new Map(),
    pendingHeads: new Map(),
    checks: new Map(),
    deploys: new Map(),
    version: "dev",
    requests: [],
    violations: [],
  };
}

let state = freshState();
/** Installation token → expiry (ms). Kept across resets, as the Worker caches its token. */
const tokens = new Map<string, number>();
let tokenCount = 0;
let nextPull = 1;
let nextRun = 1000;

// ---- Answers ----

interface Answer {
  status: number;
  body?: unknown;
}

const json = (status: number, body: unknown): Answer => ({ status, body });
const notFound = () => json(404, { message: "Not Found" });
const unprocessable = (message: string) => json(422, { message });
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

/** Records a request the Worker must never make, and refuses it. */
function violation(status: number, what: string): Answer {
  state.violations.push(what);
  // The method only: the request log (GET /__stub/requests) has the rest.
  console.error(`GitHub stub: refused a request outside the allowlist (${what.split(" ")[0]})`);
  return json(status, { message: "Not allowed by the e2e GitHub stub" });
}

/** UTF-8 text as the contents API sends it: base64, wrapped at 60 columns. */
function base64Wrapped(text: string): string {
  return `${(
    Buffer.from(text, "utf8")
      .toString("base64")
      .match(/.{1,60}/g) ?? []
  ).join("\n")}\n`;
}

/** JSON with sorted keys, to compare request bodies whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const person = (value: unknown): Person | null =>
  isObject(value) && isString(value.name) && isString(value.email)
    ? { name: value.name, email: value.email }
    : null;

// ---- Auth ----

/** The test App, read on every check so a key from a later `pnpm e2e:keys` is picked up. */
function testApp(): TestGitHubApp | null {
  if (!existsSync(GITHUB_APP_FILE)) return null;
  return JSON.parse(readFileSync(GITHUB_APP_FILE, "utf8")) as TestGitHubApp;
}

const bearer = (request: IncomingMessage) =>
  /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;

/** Whether the request carries an App JWT: RS256 with the test key, issued by the test App. */
function isAppJwt(request: IncomingMessage, app: TestGitHubApp): boolean {
  const parts = bearer(request)?.split(".") ?? [];
  if (parts.length !== 3) return false;
  const [header = "", payload = "", signature = ""] = parts;
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Json;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Json;
    const signed = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      app.publicKeySpkiPem,
      Buffer.from(signature, "base64url"),
    );
    const now = Date.now() / 1000;
    const { iat, exp } = claims;
    return (
      signed &&
      head.alg === "RS256" &&
      claims.iss === app.clientId &&
      typeof iat === "number" &&
      typeof exp === "number" &&
      exp - iat <= 600 &&
      exp > now &&
      iat <= now + 60
    );
  } catch {
    return false;
  }
}

function hasToken(request: IncomingMessage): boolean {
  const expiresAt = tokens.get(bearer(request) ?? "");
  return expiresAt !== undefined && expiresAt > Date.now();
}

const badCredentials = () => json(401, { message: "Bad credentials" });

// ---- Routes ----

interface Call {
  url: URL;
  params: string[];
  body: Json;
}

interface Route {
  method: string;
  pattern: RegExp;
  auth: "jwt" | "token";
  handle: (call: Call) => Answer;
}

/** Decodes each `/`-separated segment, as the client encodes them. */
const decodePath = (value: string) => value.split("/").map(decodeURIComponent).join("/");

function pullJson(pull: Pull) {
  return {
    number: pull.number,
    html_url: `https://github.com/${REPO}/pull/${pull.number}`,
    state: pull.state,
    merged: pull.merged,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { full_name: REPO } },
    base: { ref: "main", sha: pull.baseSha, repo: { full_name: REPO } },
    merge_commit_sha: pull.mergeSha,
  };
}

/** GitHub's background job after a push: the PR's head becomes its branch's. */
function catchUp(pull: Pull): void {
  const head = state.pendingHeads.get(pull.number);
  if (head === undefined) return;
  pull.headSha = head;
  state.pendingHeads.delete(pull.number);
}

function mintToken({ params, body }: Call): Answer {
  const app = testApp()!;
  if (params[0] !== app.installationId) return notFound();
  if (canonical(body) !== canonical(TOKEN_REQUEST)) {
    return violation(422, "POST /app/installations/:id/access_tokens not narrowed to publishing");
  }
  const token = `ghs_e2e_${++tokenCount}`;
  const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
  tokens.set(token, expiresAt);
  return json(201, {
    token,
    expires_at: new Date(expiresAt).toISOString(),
    repository_selection: "selected",
    permissions: { ...TOKEN_REQUEST.permissions, metadata: "read" },
    repositories: [{ name: "personal-website", full_name: REPO }],
  });
}

function createTree({ body }: Call): Answer {
  const { repo } = state;
  const base = repo.trees.get(String(body.base_tree));
  if (!base || !Array.isArray(body.tree)) return unprocessable("Invalid tree info");
  const files = new Map(base);
  for (const entry of body.tree as unknown[]) {
    if (!isObject(entry) || !isString(entry.path)) return unprocessable("Invalid tree info");
    if (entry.mode !== "100644" || entry.type !== "blob") return unprocessable("Invalid tree info");
    if (isString(entry.content)) files.set(entry.path, repo.addBlob(entry.content));
    else if (entry.sha === null && files.has(entry.path)) files.delete(entry.path);
    else return unprocessable("Invalid tree info");
  }
  const sha = repo.addTree(files);
  return json(201, { sha, tree: [...files].map(([path, blob]) => ({ path, sha: blob })) });
}

function createCommit({ body }: Call): Answer {
  const { repo } = state;
  const { message, tree, parents } = body;
  const author = person(body.author);
  const committer = person(body.committer);
  if (
    !isString(message) ||
    !isString(tree) ||
    !repo.trees.has(tree) ||
    !Array.isArray(parents) ||
    !parents.every((parent) => isString(parent) && repo.commits.has(parent))
  ) {
    return unprocessable("Invalid commit");
  }
  const sha = repo.addCommit({ tree, parents: parents as string[], message, author, committer });
  return json(201, { sha, tree: { sha: tree }, parents, message, author, committer });
}

function createRef({ body }: Call): Answer {
  const { repo } = state;
  const ref = String(body.ref);
  const sha = String(body.sha);
  // The App may push only blog/** branches (hosting guide §2.10, the bot ruleset).
  if (!ref.startsWith("refs/heads/blog/")) {
    return json(403, { message: "Resource not accessible by integration" });
  }
  const branch = ref.slice("refs/heads/".length);
  if (repo.refs.has(branch)) return unprocessable("Reference already exists");
  if (!repo.commits.has(sha)) return unprocessable("Object does not exist");
  repo.refs.set(branch, sha);
  return json(201, { ref, object: { sha, type: "commit" } });
}

function updateRef({ params, body }: Call): Answer {
  const { repo } = state;
  const branch = params[0]!;
  if (!branch.startsWith("blog/")) {
    return json(403, { message: "Resource not accessible by integration" });
  }
  if (body.force === true) {
    return violation(422, `PATCH ${REPO_PATH}/git/refs/heads/:branch with force`);
  }
  const current = repo.refs.get(branch);
  const next = String(body.sha);
  if (!current) return unprocessable("Reference does not exist");
  if (!repo.commits.has(next) || !repo.isAncestor(current, next)) {
    return unprocessable("Update is not a fast forward");
  }
  repo.refs.set(branch, next);
  for (const pull of state.pulls.values()) {
    if (pull.headRef === branch && pull.state === "open") state.pendingHeads.set(pull.number, next);
  }
  return json(200, { ref: `refs/heads/${branch}`, object: { sha: next, type: "commit" } });
}

function deleteRef({ params }: Call): Answer {
  const branch = params[0]!;
  if (!branch.startsWith("blog/")) {
    return json(403, { message: "Resource not accessible by integration" });
  }
  if (!state.repo.refs.delete(branch)) return unprocessable("Reference does not exist");
  return { status: 204 };
}

function createPull({ body }: Call): Answer {
  const { title, head, base } = body;
  const headSha = isString(head) ? state.repo.refs.get(head) : undefined;
  if (!isString(title) || !isString(body.body) || base !== "main" || !isString(head) || !headSha) {
    return unprocessable("Validation Failed");
  }
  const open = [...state.pulls.values()].some((p) => p.headRef === head && p.state === "open");
  if (open) return unprocessable("A pull request already exists for this branch");
  const pull: Pull = {
    number: nextPull++,
    title,
    body: body.body,
    headRef: head,
    headSha,
    baseSha: state.repo.refs.get("main")!,
    state: "open",
    merged: false,
    mergeSha: null,
    comments: [],
  };
  state.pulls.set(pull.number, pull);
  return json(201, pullJson(pull));
}

function updatePull({ params, body }: Call): Answer {
  const pull = state.pulls.get(Number(params[0]));
  if (!pull) return notFound();
  const keys = Object.keys(body);
  const allowed = keys.every((key) => ["title", "body", "state"].includes(key));
  if (!allowed || (body.state !== undefined && body.state !== "closed")) {
    return violation(422, `PATCH ${REPO_PATH}/pulls/:n with ${keys.sort().join(", ")}`);
  }
  if (body.state === "closed" && pull.merged) {
    return unprocessable("A merged pull request can't be closed");
  }
  if (isString(body.title)) pull.title = body.title;
  if (isString(body.body)) pull.body = body.body;
  if (body.state === "closed") pull.state = "closed";
  return json(200, pullJson(pull));
}

function deployRuns({ url }: Call): Answer {
  const sha = url.searchParams.get("head_sha") ?? "";
  const perPage = Number(url.searchParams.get("per_page") ?? 30);
  const runs = url.searchParams.get("event") === "push" ? (state.deploys.get(sha) ?? []) : [];
  return json(200, {
    total_count: runs.length,
    workflow_runs: runs.slice(0, perPage).map((run) => ({
      id: run.id,
      name: "Deploy",
      path: ".github/workflows/deploy.yml",
      head_sha: sha,
      event: "push",
      status: run.status,
      conclusion: run.conclusion,
      html_url: `${RUNS_URL}/${run.id}`,
    })),
  });
}

const repoRoute = (
  method: string,
  pattern: string,
  handle: Route["handle"],
  auth: Route["auth"] = "token",
): Route => ({ method, pattern: new RegExp(`^${REPO_PATH}${pattern}$`), auth, handle });

/** Every route the Worker's client may call (contract §5.3), and nothing else. */
const ROUTES: Route[] = [
  {
    method: "POST",
    pattern: /^\/app\/installations\/([^/]+)\/access_tokens$/,
    auth: "jwt",
    handle: mintToken,
  },
  { method: "GET", pattern: /^\/app$/, auth: "jwt", handle: () => json(200, { slug: APP_SLUG }) },
  {
    method: "GET",
    pattern: /^\/users\/([^/]+)$/,
    auth: "token",
    handle: ({ params }) =>
      params[0] === `${APP_SLUG}[bot]`
        ? json(200, { login: `${APP_SLUG}[bot]`, id: BOT_ID, type: "Bot" })
        : notFound(),
  },
  { method: "POST", pattern: /^\/graphql$/, auth: "token", handle: ({ body }) => graphql(body) },
  repoRoute("GET", "/git/ref/heads/(.+)", ({ params }) => {
    const sha = state.repo.refs.get(params[0]!);
    if (!sha) return notFound();
    return json(200, { ref: `refs/heads/${params[0]}`, object: { sha, type: "commit" } });
  }),
  repoRoute("GET", "/git/commits/([0-9a-f]{40})", ({ params }) => {
    const commit = state.repo.commits.get(params[0]!);
    if (!commit) return notFound();
    return json(200, {
      sha: commit.sha,
      tree: { sha: commit.tree },
      parents: commit.parents.map((sha) => ({ sha })),
      message: commit.message,
      author: commit.author,
      committer: commit.committer,
    });
  }),
  repoRoute("GET", "/contents/(.+)", ({ params, url }) => {
    const commit = state.repo.resolve(url.searchParams.get("ref") ?? "main");
    const path = params[0]!;
    const file = commit === null ? null : state.repo.fileAt(commit, path);
    if (!file) return notFound();
    return json(200, {
      type: "file",
      name: path.split("/").at(-1),
      path,
      sha: file.sha,
      size: Buffer.byteLength(file.text),
      encoding: "base64",
      content: base64Wrapped(file.text),
    });
  }),
  repoRoute("GET", "/pulls/(\\d+)", ({ params }) => {
    const pull = state.pulls.get(Number(params[0]));
    if (!pull) return notFound();
    const answer = json(200, pullJson(pull));
    catchUp(pull);
    return answer;
  }),
  repoRoute("POST", "/git/trees", createTree),
  repoRoute("POST", "/git/commits", createCommit),
  repoRoute("POST", "/git/refs", createRef),
  repoRoute("PATCH", "/git/refs/heads/(.+)", updateRef),
  repoRoute("DELETE", "/git/refs/heads/(.+)", deleteRef),
  repoRoute("POST", "/pulls", createPull),
  repoRoute("PATCH", "/pulls/(\\d+)", updatePull),
  repoRoute("POST", "/issues/(\\d+)/comments", ({ params, body }) => {
    const pull = state.pulls.get(Number(params[0]));
    if (!pull) return notFound();
    if (!isString(body.body)) return unprocessable("Validation Failed");
    pull.comments.push(body.body);
    return json(201, { id: pull.comments.length, body: body.body });
  }),
  repoRoute("GET", "/actions/workflows/deploy\\.yml/runs", deployRuns),
  repoRoute("GET", "/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})", ({ params }) => {
    const [base = "", head = ""] = params;
    if (!state.repo.commits.has(base) || !state.repo.commits.has(head)) return notFound();
    return json(200, { status: state.repo.compare(base, head) });
  }),
];

// ---- GraphQL: the four fixed queries ----

function graphql(body: Json): Answer {
  const query = isString(body.query) ? body.query : "";
  if (/\bmutation\b/i.test(query)) return violation(500, "POST /graphql mutation");
  const name = String(body.operationName);
  if (!QUERIES.has(name) || !new RegExp(`^\\s*query ${name}\\(`).test(query)) {
    return violation(501, `POST /graphql ${name}`);
  }
  const variables = isObject(body.variables) ? body.variables : {};
  if (variables.owner !== "TheRizz" || variables.name !== "personal-website") {
    return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND" }] });
  }
  const { repo } = state;
  const main = repo.refs.get("main")!;
  switch (name) {
    case "PostsTree": {
      const blog = repo.blogDirectory(main);
      return json(200, { data: { repository: { object: blog ? { oid: blog.oid } : null } } });
    }
    case "PostsOnMain": {
      const blog = repo.blogDirectory(main);
      if (!blog) return json(200, { data: { repository: { object: null } } });
      const entries = blog.entries.map((entry) => {
        const text = entry.type === "blob" ? (repo.blobs.get(entry.oid) ?? "") : null;
        return {
          name: entry.name,
          type: entry.type,
          oid: entry.oid,
          object:
            text === null
              ? {}
              : { byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false, text },
        };
      });
      return json(200, { data: { repository: { object: { oid: blog.oid, entries } } } });
    }
    case "OpenPullHeads": {
      const open = [...state.pulls.values()].filter((pull) => pull.state === "open");
      const start = isString(variables.after) ? Number(variables.after) : 0;
      const nodes = open.slice(start, start + 100).map((pull) => ({
        number: pull.number,
        headRefName: pull.headRef,
        isCrossRepository: false,
      }));
      const end = start + nodes.length;
      const pageInfo = { hasNextPage: end < open.length, endCursor: String(end) };
      return json(200, { data: { repository: { pullRequests: { nodes, pageInfo } } } });
    }
    default:
      return publishStatus(variables);
  }
}

function publishStatus(variables: Json): Answer {
  const { repo } = state;
  const pull = state.pulls.get(Number(variables.number));
  const head = String(variables.head);
  const run = state.checks.get(head);
  const suites = run
    ? [
        {
          createdAt: run.createdAt,
          app: { slug: "github-actions" },
          checkRuns: {
            nodes: [
              {
                status: run.status,
                conclusion: run.conclusion,
                detailsUrl: `${RUNS_URL}/${run.runId}/job/${run.runId * 10}`,
              },
            ],
          },
        },
      ]
    : [];
  const object = repo.commits.has(head) ? { checkSuites: { nodes: suites } } : null;
  if (!pull) {
    return json(200, {
      data: { repository: { pullRequest: null, object } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"] }],
    });
  }
  let mergeCommit = null;
  if (pull.mergeSha) {
    const file = repo.fileAt(pull.mergeSha, String(variables.path));
    mergeCommit = {
      oid: pull.mergeSha,
      file: file ? { oid: file.sha, object: { text: file.text, isTruncated: false } } : null,
    };
  }
  const answer = json(200, {
    data: {
      repository: {
        pullRequest: {
          state: pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED",
          merged: pull.merged,
          headRefName: pull.headRef,
          headRefOid: pull.headSha,
          baseRefName: "main",
          headRepository: { nameWithOwner: REPO },
          mergeCommit,
        },
        object,
      },
    },
  });
  catchUp(pull);
  return answer;
}

// ---- Control API: the owner and GitHub Actions ----

function commitsOf(pull: Pull): StubCommit[] {
  const { repo } = state;
  const base = repo.mergeBase(pull.headSha, pull.baseSha) ?? pull.baseSha;
  return repo.commitsBetween(base, pull.headSha).map((commit) => ({
    sha: commit.sha,
    parents: commit.parents,
    message: commit.message,
    author: commit.author,
    committer: commit.committer,
    paths: [...repo.filesAt(commit.sha).keys()],
  }));
}

function snapshot(): StubState {
  const { repo } = state;
  return {
    version: state.version,
    refs: Object.fromEntries(repo.refs),
    mainPaths: [...repo.filesAt(repo.refs.get("main")!).keys()],
    pulls: [...state.pulls.values()].map((pull) => ({
      ...pull,
      comments: [...pull.comments],
      commits: commitsOf(pull),
    })),
    violations: [...state.violations],
  };
}

const CHECK_STATUSES = new Set(["queued", "in_progress", "completed"]);
const RUN_CONCLUSIONS = new Set(["success", "failure", "cancelled"]);

/** A run's status and conclusion from a control request, or null when they don't fit. */
function runResult(body: Json): { status: string; conclusion: string | null } | null {
  const { status, conclusion } = body;
  if (!isString(status) || !CHECK_STATUSES.has(status)) return null;
  if (status !== "completed") return conclusion === undefined ? { status, conclusion: null } : null;
  return isString(conclusion) && RUN_CONCLUSIONS.has(conclusion) ? { status, conclusion } : null;
}

function control(method: string, path: string, body: Json): Answer {
  if (method === "POST" && path === "/__stub/reset") {
    state = freshState();
    return json(200, { ok: true });
  }
  for (const pull of state.pulls.values()) catchUp(pull);
  if (method === "GET" && path === "/__stub/state") return json(200, snapshot());
  if (method === "GET" && path === "/__stub/requests") return json(200, state.requests);
  if (method === "POST" && path === "/__stub/version") {
    if (!isString(body.version) || !body.version) return unprocessable("version is required");
    state.version = body.version;
    return json(200, { version: state.version });
  }
  if (method === "POST" && path === "/__stub/main/files") {
    const { content } = body;
    if (!isString(body.path) || !(isString(content) || content === null)) {
      return unprocessable("path and content (a string, or null to delete) are required");
    }
    return json(200, { commit: state.repo.commitToMain(body.path, content) });
  }
  const deploy = /^\/__stub\/deploys\/([0-9a-f]{40})$/.exec(path);
  if (method === "POST" && deploy) {
    const result = runResult(body);
    if (!result) return unprocessable("status: queued, in_progress or completed with a conclusion");
    const run = { id: nextRun++, ...result };
    state.deploys.set(deploy[1]!, [run, ...(state.deploys.get(deploy[1]!) ?? [])]);
    return json(200, { runUrl: `${RUNS_URL}/${run.id}` });
  }

  const action = /^\/__stub\/pulls\/(\d+)\/(checks|merge|close)$/.exec(path);
  const pull = action ? state.pulls.get(Number(action[1])) : undefined;
  if (method !== "POST" || !action) return json(404, { message: "No such control route" });
  if (!pull) return notFound();
  switch (action[2]) {
    case "checks": {
      const result = runResult(body);
      if (!result || result.conclusion === "cancelled") {
        return unprocessable("status: queued, in_progress or completed with success or failure");
      }
      const run: CheckRun = {
        createdAt: new Date().toISOString(),
        status: result.status.toUpperCase(),
        conclusion: result.conclusion?.toUpperCase() ?? null,
        runId: nextRun++,
      };
      state.checks.set(pull.headSha, run);
      return json(200, { head: pull.headSha, runUrl: `${RUNS_URL}/${run.runId}` });
    }
    case "merge": {
      if (pull.state !== "open") return unprocessable("Pull request is not open");
      const author = commitsOf(pull)[0]?.author ?? null;
      const message = `${pull.title} (#${pull.number})`;
      pull.mergeSha = state.repo.squashMerge(pull.headSha, message, author);
      // GitHub deletes the head branch after the merge (the repository setting).
      state.repo.refs.delete(pull.headRef);
      pull.state = "closed";
      pull.merged = true;
      return json(200, { mergeSha: pull.mergeSha });
    }
    default: {
      if (pull.state !== "open") return unprocessable("Pull request is not open");
      pull.state = "closed";
      return json(200, { ok: true });
    }
  }
}

// ---- Server ----

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(size === 0 ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseBody(text: string | null): Json {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

async function answer(request: IncomingMessage): Promise<Answer> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const text = await readBody(request);
  const body = parseBody(text);
  if (url.pathname.startsWith("/__stub/")) return control(method, url.pathname, body);

  const operationName = isString(body.operationName) ? body.operationName : undefined;
  state.requests.push({
    method,
    path: url.pathname + url.search,
    ...(operationName !== undefined && { operationName }),
    body: text,
  });
  if (/\/pulls\/\d+\/merge$|\/merges$/.test(url.pathname)) {
    return violation(500, `${method} ${url.pathname}`);
  }
  if (method === "GET" && url.pathname === "/__e2e/health") {
    return json(200, { ok: true, version: state.version });
  }
  if (url.pathname.startsWith("/repos/") && !url.pathname.startsWith(`${REPO_PATH}/`)) {
    return violation(404, `${method} ${url.pathname}`);
  }

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    if (route.auth === "jwt") {
      const app = testApp();
      if (!app) {
        return json(401, { message: "e2e/.auth/github-app.json is missing; run pnpm e2e:keys" });
      }
      if (!isAppJwt(request, app)) return badCredentials();
    } else if (!hasToken(request)) {
      return badCredentials();
    }
    return route.handle({ url, params: match.slice(1).map(decodePath), body });
  }
  return violation(501, `${method} ${url.pathname}`);
}

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let result: Answer;
  try {
    result = await answer(request);
  } catch (error) {
    state.violations.push(`stub error on ${request.method} ${request.url}`);
    console.error("GitHub stub: internal error:", error instanceof Error ? error.message : error);
    result = json(500, { message: "The e2e GitHub stub failed" });
  }
  // workerd pools connections longer than Node keeps them alive, which would occasionally end
  // in "Network connection lost"; one request per connection avoids that.
  const headers: Record<string, string> = { Connection: "close" };
  if (result.body === undefined) {
    response.writeHead(result.status, headers).end();
    return;
  }
  headers["Content-Type"] = "application/json; charset=utf-8";
  response.writeHead(result.status, headers).end(JSON.stringify(result.body));
}

const port = githubStubPort();
const server = createServer((request, response) => void respond(request, response));
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`GitHub stub: can't listen on 127.0.0.1:${port} (${error.code ?? error.message})`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`GitHub stub listening on http://127.0.0.1:${port}`);
});
