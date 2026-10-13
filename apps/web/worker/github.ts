import { SignJWT, importPKCS8 } from "jose";
import { isBranch, isGitSha, isPostPath } from "../app/lib/publish/post-path";
import { isLocalHost } from "./admin-auth";

/** The build's commit SHA (vite.config.ts); not defined under Vitest. */
declare const __APP_VERSION__: string | undefined;

// The GitHub App client the editor publishes through (design doc §4.9.7). It can only do what
// publishing needs: read refs, commits, files and pull requests, push a commit to a `blog/**`
// branch, open, edit and close a PR, comment on it, and read check and deploy runs. There is no
// merge, no auto-merge, no force push and no raw request; GraphQL is limited to four fixed
// queries. Every request is checked for the owner's private address before it is sent, and
// nothing that names a post, a draft or a token is ever logged.

/** The bindings the client reads. The App's key, client id and installation id are secrets. */
export interface GitHubEnv {
  /** The App's key PEM as GitHub downloads it (PKCS#1) or as PKCS#8 (hosting guide §2.10 step 5). */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  /** The commit author, `Name <id+login@users.noreply.github.com>`; a plain var. */
  GIT_AUTHOR?: string;
  /** The e2e stub's origin. Only ever in the gitignored `.dev.vars`, honoured on localhost only. */
  GITHUB_API_BASE?: string;
  OWNER_EMAIL?: string;
  /** Read only to refuse publishing when the e2e test key is set without the stub. */
  ACCESS_TEST_JWKS?: string;
}

export const REPO = { owner: "TheRizz", name: "personal-website" } as const;
export const REPO_FULL_NAME = "TheRizz/personal-website";
export const USER_AGENT = "ry-mart-publisher";

const API_BASE = "https://api.github.com";
const REPO_PATH = `/repos/${REPO_FULL_NAME}`;
const TIMEOUT_MS = 10_000;
/** A cached installation token is used while it has at least this long left. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const MAX_PULL_PAGES = 5;
const GIT_AUTHOR = /^(.+?) <([^<>\s]+@users\.noreply\.github\.com)>$/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The token is minted for this repository only, with only the permissions publishing uses. */
const TOKEN_REQUEST = {
  repositories: [REPO.name],
  permissions: { contents: "write", pull_requests: "write", actions: "read", checks: "read" },
};
/** The most a minted token may grant; GitHub adds `metadata: read` to every App token. */
const GRANTABLE: Record<string, "read" | "write"> = {
  contents: "write",
  pull_requests: "write",
  actions: "read",
  checks: "read",
  metadata: "read",
};

/** Publishing can't run: not configured, or configured somewhere it must not run. */
export class GitHubUnavailable extends Error {
  constructor(readonly code: "github_unavailable" | "misconfigured") {
    super(code);
    this.name = "GitHubUnavailable";
  }
}

/** GitHub answered something other than what the call expects. */
export class GitHubError extends Error {
  /** `operation` is `<METHOD> <route template>`, so the message holds no values. */
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`${operation} -> ${status}`);
    this.name = "GitHubError";
  }
}

/** A request would have carried the owner's private address; it was not sent. */
export class OwnerEmailInBody extends Error {
  constructor() {
    super("a GitHub request would contain the owner's address");
    this.name = "OwnerEmailInBody";
  }
}

/** A git identity, as commits take it. */
export interface Identity {
  name: string;
  email: string;
}

/** A file in a tree change: its new text, or `sha: null` to delete it. */
export type TreeEntry =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: null };

/** A file read from the repo. `text` is null when it is over 1 MB or isn't UTF-8 text. */
export interface RepoFile {
  sha: string;
  text: string | null;
  problem: "too_large" | "binary" | null;
}

/**
 * A pull request as REST reads it. Its head SHA is left out: GitHub moves it a little after a
 * push, so the branch's ref is the one to compare.
 */
export interface PullRequest {
  state: string;
  merged: boolean;
  headRef: string;
  /** `owner/name` of the head repository; null when it was deleted. */
  headRepo: string | null;
  baseRef: string;
}

/** The newest `deploy.yml` push run for a commit. */
export interface DeployRun {
  status: string;
  conclusion: string | null;
  html_url: string;
}

export interface PostsTreeEntry {
  name: string;
  type: string;
  oid: string;
  object: { byteSize: number; isBinary: boolean; isTruncated: boolean; text: string | null } | null;
}

export interface OpenPullHead {
  number: number;
  headRefName: string;
  isCrossRepository: boolean;
}

/** One `PublishStatus` answer: the PR as GitHub has it, and the `ci` run of its head commit. */
export interface PullRequestStatus {
  pullRequest: null | {
    state: "OPEN" | "CLOSED" | "MERGED";
    merged: boolean;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    /** `owner/name`, or null when the head repository is gone. */
    headRepository: string | null;
    mergeCommit: null | {
      oid: string;
      /** The post file at the merge commit; null when it isn't there (an unpublish). */
      file: null | { oid: string; text: string | null; isTruncated: boolean };
    };
  };
  ci: null | { status: string; conclusion: string | null; detailsUrl: string | null };
}

/** Everything publishing can ask of GitHub. */
export interface GitHub {
  /** The commit author from `GIT_AUTHOR`, checked against the owner's address. */
  readonly author: Identity;
  getRef(branch: string): Promise<string | null>;
  getCommit(sha: string): Promise<{ tree: string }>;
  getFile(path: string, ref: string): Promise<RepoFile | null>;
  getPull(n: number): Promise<PullRequest>;
  createTree(baseTree: string, entries: TreeEntry[]): Promise<string>;
  createCommit(commit: {
    message: string;
    tree: string;
    parents: string[];
    author: Identity;
    committer: Identity;
  }): Promise<string>;
  createRef(branch: string, sha: string): Promise<"created" | "exists">;
  updateRef(branch: string, sha: string): Promise<"updated" | "not_fast_forward">;
  deleteRef(branch: string): Promise<void>;
  createPull(pull: { title: string; head: string; body: string }): Promise<number>;
  updatePull(
    n: number,
    pull: { title?: string; body?: string; state?: "closed" },
  ): Promise<{ ok: true; state: string; merged: boolean } | { ok: false; status: number }>;
  createComment(n: number, body: string): Promise<void>;
  deployRuns(sha: string): Promise<DeployRun | null>;
  compare(base: string, head: string): Promise<string>;
  postsTree(): Promise<string | null>;
  postsOnMain(): Promise<{ oid: string; entries: PostsTreeEntry[] } | null>;
  openPullHeads(): Promise<OpenPullHead[]>;
  publishStatus(query: { number: number; head: string; path: string }): Promise<PullRequestStatus>;
  /** The App's bot, the committer of every commit: `<slug>[bot]` and its no-reply address. */
  botIdentity(): Promise<Identity>;
  /** The version the site serves now: this Worker's build, or the e2e stub's. */
  liveVersion(): Promise<string>;
}

// ---- The owner's address ----

const NAMED_REFERENCES: Record<string, string> = {
  commat: "@",
  period: ".",
  lowbar: "_",
  underbar: "_",
  plus: "+",
  hyphen: "-",
  dash: "-",
  amp: "&",
};
const REFERENCE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const ESCAPED_PUNCTUATION = /\\([!-/:-@[-`{-~])/g;

function decodeReferences(text: string): string {
  return text.replace(REFERENCE, (match, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? match;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Decodes each run of valid `%HH`; a run that isn't UTF-8 decodes its ASCII bytes only. */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-7][0-9a-f])/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
}

/** The text with the usual ways of hiding an `@` undone, twice over for double encodings. */
function unmask(text: string): string {
  let result = text;
  for (let pass = 0; pass < 2; pass++) {
    result = result.normalize("NFKC");
    result = decodeReferences(result);
    result = percentDecode(result);
    result = result.replace(INVISIBLE, "");
    result = result.replace(ESCAPED_PUNCTUATION, "$1");
  }
  return result.toLowerCase();
}

/**
 * Whether `text` holds `ownerEmail` (lowercase), ignoring case and the ways Markdown, HTML and
 * URLs can spell an address: `a\@b` (the editor stores a typed `@` so), `a&#64;b`, `a%40b`, an
 * invisible character after the `@`, a full-width `＠`. Errs towards yes: a false match only
 * stops a publish.
 */
export function containsOwnerEmail(text: string, ownerEmail: string): boolean {
  if (!ownerEmail) throw new Error("containsOwnerEmail needs the owner's address");
  return unmask(text).includes(ownerEmail);
}

/** `OWNER_EMAIL` trimmed and lowercased, as the gate reads it; "" when unset. */
export function ownerEmailOf(env: GitHubEnv): string {
  return env.OWNER_EMAIL?.trim().toLowerCase() ?? "";
}

/** Whether any string anywhere in `value` passes `test`. */
function someString(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === "string") return test(value);
  if (Array.isArray(value)) return value.some((item) => someString(item, test));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => someString(item, test));
  }
  return false;
}

// ---- Configuration ----

function misconfigured(name: string): GitHubUnavailable {
  // The name only: never the value.
  console.error("Publishing is misconfigured:", name);
  return new GitHubUnavailable("misconfigured");
}

/** The author from `GIT_AUTHOR`, or null if it isn't a no-reply identity clear of the owner. */
function parseAuthor(value: string | undefined, ownerEmail: string): Identity | null {
  const text = value?.trim() ?? "";
  const match = GIT_AUTHOR.exec(text);
  if (!match?.[1] || !match[2]) return null;
  if (match[2].toLowerCase() === ownerEmail || containsOwnerEmail(text, ownerEmail)) return null;
  return { name: match[1], email: match[2] };
}

/** The origin of a local stub base, or null unless it is a bare http(s) origin on this machine. */
function localBase(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const ok =
    (url.protocol === "http:" || url.protocol === "https:") &&
    isLocalHost(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  return ok ? url.origin : null;
}

/**
 * A PEM with LF line endings and no surrounding whitespace: the label and the base64 body. A paste
 * may leave spaces after the BEGIN line or indent the END line; both are allowed.
 */
const PEM = /^-----BEGIN ([A-Z ]+)-----[ \t]*\n([A-Za-z0-9+/=\s]+)\n[ \t]*-----END \1-----$/;
/** DER for `INTEGER 0` and for `SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }`. */
const DER_VERSION_0 = [0x02, 0x01, 0x00];
const DER_RSA_ENCRYPTION = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** A DER element: the tag, the length (one byte under 128, else a count then big-endian bytes). */
function der(tag: number, body: ArrayLike<number>): number[] {
  const length: number[] = [];
  for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256)) length.unshift(rest % 256);
  const prefix = body.length < 0x80 ? [body.length] : [0x80 | length.length, ...length];
  return [tag, ...prefix, ...Array.from(body)];
}

/**
 * The App's key as a PKCS#8 PEM, or null unless `pem` is a plain private key. GitHub downloads
 * App keys as PKCS#1 (`RSA PRIVATE KEY`), which WebCrypto doesn't import, so that DER is wrapped
 * in a PKCS#8 PrivateKeyInfo here: SEQUENCE { INTEGER 0, the rsaEncryption algorithm, OCTET
 * STRING <the PKCS#1 key> }. A PKCS#8 key passes through; an encrypted key doesn't.
 */
function pkcs8Pem(pem: string): string | null {
  const match = PEM.exec(pem);
  if (!match) return null;
  const [, label, body] = match;
  if (label === "PRIVATE KEY") return pem;
  if (label !== "RSA PRIVATE KEY") return null;
  let pkcs1: Uint8Array;
  try {
    pkcs1 = Uint8Array.from(atob(body!.replace(/\s/g, "")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  const info = der(0x30, [...DER_VERSION_0, ...DER_RSA_ENCRYPTION, ...der(0x04, pkcs1)]);
  const base64 = btoa(info.map((byte) => String.fromCharCode(byte)).join(""));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

// ---- Caches shared across requests: resolved values only, never a promise ----

const tokens = new Map<string, { token: string; expiresAt: number }>();
const bots = new Map<string, Identity>();
const signingKeys = new Map<string, CryptoKey>();

/** Empties the isolate's token, bot and key caches. For tests. */
export function resetGitHubCaches(): void {
  tokens.clear();
  bots.clear();
  signingKeys.clear();
}

/** The GraphQL documents the client can send; nothing else reaches `/graphql`. */
const QUERIES = {
  PostsTree: `query PostsTree($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { object(expression: "main:content/blog") { ... on Tree { oid } } }
}`,
  PostsOnMain: `query PostsOnMain($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: "main:content/blog") { ... on Tree { oid entries { name type oid
      object { ... on Blob { byteSize isBinary isTruncated text } } } } }
  }
}`,
  OpenPullHeads: `query OpenPullHeads($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after) {
      nodes { number headRefName isCrossRepository }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
  PublishStatus: `query PublishStatus($owner: String!, $name: String!, $number: Int!, $head: GitObjectID!, $path: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state merged headRefName headRefOid baseRefName
      headRepository { nameWithOwner }
      mergeCommit { oid file(path: $path) { oid object { ... on Blob { text isTruncated } } } }
    }
    object(oid: $head) {
      ... on Commit {
        checkSuites(first: 10, filterBy: { appId: 15368 }) {
          nodes {
            createdAt
            app { slug }
            checkRuns(first: 1, filterBy: { checkName: "ci", checkType: LATEST }) {
              nodes { status conclusion detailsUrl }
            }
          }
        }
      }
    }
  }
}`,
} as const;

type QueryName = keyof typeof QUERIES;

/** Throws for a GraphQL document that could change anything. Every document is checked. */
export function assertQuery(document: string): void {
  if (/\bmutation\b/i.test(document)) throw new Error("GraphQL mutations are never sent");
}

// ---- Input checks: a bad value throws before anything is sent ----

function invalidInput(): Error {
  return new Error("invalid GitHub input");
}
function checkSha(sha: string): string {
  if (!isGitSha(sha)) throw invalidInput();
  return sha;
}
function checkBranch(branch: string): string {
  if (!isBranch(branch)) throw invalidInput();
  return branch;
}
function checkNumber(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw invalidInput();
  return n;
}
function checkEntry(entry: TreeEntry): TreeEntry {
  const ok =
    isPostPath(entry.path) &&
    entry.mode === "100644" &&
    entry.type === "blob" &&
    ("content" in entry ? typeof entry.content === "string" : entry.sha === null);
  if (!ok) throw invalidInput();
  return entry;
}

/** A path with each segment encoded, so a value can't add segments or a query. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

// ---- Reading answers ----

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `path` in `data` when it is an object, else undefined. */
function field(data: unknown, ...path: string[]): unknown {
  let value = data;
  for (const key of path) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** UTF-8 text from GitHub's base64 (wrapped at 60 columns), or null if it isn't UTF-8. */
function decodeBase64(content: string): string | null {
  try {
    const binary = atob(content.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The `ci` run to show: from GitHub Actions suites, the one in the most recent suite. */
function ciRun(suites: unknown): PullRequestStatus["ci"] {
  if (!Array.isArray(suites)) return null;
  let best: { createdAt: string; run: Json } | null = null;
  for (const suite of suites) {
    if (field(suite, "app", "slug") !== "github-actions") continue;
    const runs = field(suite, "checkRuns", "nodes");
    const run: unknown = Array.isArray(runs) ? runs[0] : undefined;
    const createdAt = field(suite, "createdAt");
    if (!isObject(run) || typeof createdAt !== "string") continue;
    // On a tie the later suite in GitHub's list (the later one created) wins.
    if (!best || Date.parse(createdAt) >= Date.parse(best.createdAt)) best = { createdAt, run };
  }
  if (!best || typeof best.run.status !== "string") return null;
  const { status, conclusion, detailsUrl } = best.run;
  return {
    status,
    conclusion: typeof conclusion === "string" ? conclusion : null,
    detailsUrl: typeof detailsUrl === "string" ? detailsUrl : null,
  };
}

// ---- The client ----

interface Call {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The route template, for errors and logs. */
  route: string;
  /** The real path, with encoded values. */
  path: string;
  auth: "token" | "jwt" | "none";
  body?: Json;
}

interface Answer {
  status: number;
  data: unknown;
}

/**
 * The client for one request. Checks the configuration before anything else and throws
 * `GitHubUnavailable` (sending nothing) when publishing mustn't or can't run here.
 */
export function createGitHub(
  env: GitHubEnv,
  requestUrl: string,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): GitHub {
  const ownerEmail = ownerEmailOf(env);
  if (!ownerEmail) throw misconfigured("OWNER_EMAIL");
  const author = parseAuthor(env.GIT_AUTHOR, ownerEmail);
  if (!author) throw misconfigured("GIT_AUTHOR");

  let base = API_BASE;
  let stub = false;
  const override = env.GITHUB_API_BASE?.trim();
  if (override) {
    const host = new URL(requestUrl).hostname;
    if (!isLocalHost(host)) {
      console.error(`ALERT: GITHUB_API_BASE is configured on ${host}; refusing to publish`);
      throw new GitHubUnavailable("github_unavailable");
    }
    const local = localBase(override);
    if (!local) throw misconfigured("GITHUB_API_BASE");
    base = local;
    stub = true;
  }
  if (env.ACCESS_TEST_JWKS && !stub) {
    console.error(
      "ALERT: the e2e test key is configured without the GitHub stub; refusing to publish",
    );
    throw new GitHubUnavailable("github_unavailable");
  }

  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim() ?? "";
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  // `.dev.vars` holds the key on one line with literal \n sequences; a paste may carry CRLF.
  const pem =
    env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim() ?? "";
  if (!/^\d+$/.test(installationId)) throw misconfigured("GITHUB_APP_INSTALLATION_ID");
  if (!clientId) throw misconfigured("GITHUB_APP_CLIENT_ID");
  if (!pem) throw misconfigured("GITHUB_APP_PRIVATE_KEY");

  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const cacheKey = `${base}|${installationId}|${clientId}`;
  // This request's mint while it runs; other requests never wait on it.
  let minting: Promise<string> | null = null;

  /** The key, imported once per key text; PKCS#1 is wrapped as PKCS#8 on the way in. */
  async function signingKey(): Promise<CryptoKey> {
    const cached = signingKeys.get(pem);
    if (cached) return cached;
    const pkcs8 = pkcs8Pem(pem);
    if (!pkcs8) throw misconfigured("GITHUB_APP_PRIVATE_KEY");
    let key: CryptoKey;
    try {
      key = await importPKCS8(pkcs8, "RS256");
    } catch {
      throw misconfigured("GITHUB_APP_PRIVATE_KEY");
    }
    signingKeys.set(pem, key);
    return key;
  }

  /** An App JWT: RS256, issued a minute back for clock drift, valid for 9 minutes. */
  async function appJwt(): Promise<string> {
    const seconds = Math.floor(now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt(seconds - 60)
      .setExpirationTime(seconds + 540)
      .setIssuer(clientId)
      .sign(await signingKey());
  }

  /** One HTTP exchange. Every response body is read or cancelled. */
  async function exchange(call: Call, bearer: string | null): Promise<Answer> {
    const url = `${base}${call.path}`;
    const operation = `${call.method} ${call.route}`;
    const mentions = (text: string) => containsOwnerEmail(text, ownerEmail);
    if (mentions(url) || (call.body && someString(call.body, mentions))) {
      throw new OwnerEmailInBody();
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (call.body) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await send(url, {
        method: call.method,
        headers,
        body: call.body ? JSON.stringify(call.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // A redirect could carry the token to another origin, so it is an error instead.
        redirect: "manual",
      });
    } catch {
      throw new GitHubError(0, operation);
    }
    const { status } = response;
    const ok = status >= 200 && status < 300 && status !== 204;
    if (!ok || response.type === "opaqueredirect") {
      // Not awaited: the connection is released either way, and a teed body never settles.
      void response.body?.cancel().catch(() => {});
      if ((status >= 300 && status < 400) || response.type === "opaqueredirect") {
        throw new GitHubError(status, operation);
      }
      return { status, data: null };
    }
    try {
      return { status, data: await response.json() };
    } catch {
      throw new GitHubError(status, operation);
    }
  }

  async function mint(): Promise<string> {
    const route = "/app/installations/:id/access_tokens";
    const operation = `POST ${route}`;
    const answer = await exchange(
      {
        method: "POST",
        route,
        path: `/app/installations/${installationId}/access_tokens`,
        auth: "jwt",
        body: TOKEN_REQUEST,
      },
      await appJwt(),
    );
    if ([401, 403, 404, 422].includes(answer.status)) {
      console.error("Publishing is misconfigured: the App's token request was refused");
      throw new GitHubUnavailable("misconfigured");
    }
    if (answer.status < 200 || answer.status >= 300)
      throw new GitHubError(answer.status, operation);

    const grant = answer.data;
    const token = field(grant, "token");
    const expiresAt = Date.parse(String(field(grant, "expires_at")));
    if (typeof token !== "string" || !token || Number.isNaN(expiresAt)) {
      throw new GitHubError(answer.status, operation);
    }
    // Fail closed unless the token is exactly as narrow as asked.
    const problems: string[] = [];
    if (field(grant, "repository_selection") !== "selected") problems.push("repository_selection");
    const permissions = field(grant, "permissions");
    if (!isObject(permissions)) problems.push("permissions");
    else {
      for (const [name, level] of Object.entries(permissions)) {
        const most = GRANTABLE[name];
        const allowed = most && (level === "read" || (level === "write" && most === "write"));
        if (!allowed) problems.push(`permissions.${name}`);
      }
    }
    const repositories = field(grant, "repositories");
    if (
      repositories !== undefined &&
      !(
        Array.isArray(repositories) &&
        repositories.length === 1 &&
        field(repositories[0], "name") === REPO.name
      )
    ) {
      problems.push("repositories");
    }
    if (problems.length > 0) {
      console.error("Publishing is misconfigured: the App's token grants", problems.join(", "));
      throw new GitHubUnavailable("misconfigured");
    }
    tokens.set(cacheKey, { token, expiresAt });
    return token;
  }

  /** A cached token with 5 minutes left, else a fresh one (one mint per request at a time). */
  function installationToken(): Promise<string> {
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - now() >= TOKEN_MARGIN_MS) return Promise.resolve(cached.token);
    minting ??= mint().finally(() => {
      minting = null;
    });
    return minting;
  }

  /** A call with the installation token, re-minted and retried once after a 401. */
  async function request(call: Call): Promise<Answer> {
    if (call.auth === "jwt") return exchange(call, await appJwt());
    if (call.auth === "none") return exchange(call, null);
    const first = await exchange(call, await installationToken());
    if (first.status !== 401) return first;
    tokens.delete(cacheKey);
    const second = await exchange(call, await installationToken());
    if (second.status === 401) throw new GitHubError(401, `${call.method} ${call.route}`);
    return second;
  }

  /** The answer's data when the status is 2xx, else `GitHubError`. */
  function expectOk(call: Call, answer: Answer): unknown {
    if (answer.status < 200 || answer.status >= 300) {
      throw new GitHubError(answer.status, `${call.method} ${call.route}`);
    }
    return answer.data;
  }

  /** A required value from an answer; anything else means GitHub answered unexpectedly. */
  function required<T>(
    call: Call,
    answer: Answer,
    value: unknown,
    check: (v: unknown) => v is T,
  ): T {
    if (!check(value)) throw new GitHubError(answer.status, `${call.method} ${call.route}`);
    return value;
  }

  const repo = (
    route: string,
    path: string,
    method: Call["method"] = "GET",
    body?: Json,
  ): Call => ({
    method,
    route: `/repos/:repo${route}`,
    path: `${REPO_PATH}${path}`,
    auth: "token",
    body,
  });

  /** One of the fixed queries. Returns `repository`; null there means the App lost the repo. */
  async function graphql(name: QueryName, variables: Json = {}): Promise<Json> {
    const query = QUERIES[name];
    assertQuery(query);
    const call: Call = {
      method: "POST",
      route: "/graphql",
      path: "/graphql",
      auth: "token",
      body: {
        query,
        operationName: name,
        variables: { owner: REPO.owner, name: REPO.name, ...variables },
      },
    };
    const operation = `POST /graphql ${name}`;
    const answer = await request(call);
    if (answer.status !== 200) throw new GitHubError(answer.status, operation);
    const errors = field(answer.data, "errors");
    // NOT_FOUND only nulls the field it is about; anything else is a failed query.
    if (
      errors !== undefined &&
      !(Array.isArray(errors) && errors.every((error) => field(error, "type") === "NOT_FOUND"))
    ) {
      throw new GitHubError(200, operation);
    }
    const repository = field(answer.data, "data", "repository");
    if (repository === null) throw new GitHubUnavailable("github_unavailable");
    if (!isObject(repository)) throw new GitHubError(200, operation);
    return repository;
  }

  const isString = (v: unknown): v is string => typeof v === "string";
  const isSha = (v: unknown): v is string => isGitSha(v);
  const isPositive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

  return {
    author,

    async getRef(branch) {
      if (branch !== "main") checkBranch(branch);
      const call = repo("/git/ref/heads/:branch", `/git/ref/heads/${encodePath(branch)}`);
      const answer = await request(call);
      if (answer.status === 404) return null;
      return required(call, answer, field(expectOk(call, answer), "object", "sha"), isSha);
    },

    async getCommit(sha) {
      const call = repo("/git/commits/:sha", `/git/commits/${checkSha(sha)}`);
      const answer = await request(call);
      return { tree: required(call, answer, field(expectOk(call, answer), "tree", "sha"), isSha) };
    },

    async getFile(path, ref) {
      if (!isPostPath(path) || (ref !== "main" && !isGitSha(ref))) throw invalidInput();
      const call = repo(
        "/contents/:path",
        `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      );
      const answer = await request(call);
      if (answer.status === 404) return null;
      const data = expectOk(call, answer);
      if (field(data, "type") !== "file") throw new GitHubError(answer.status, `GET ${call.route}`);
      const sha = required(call, answer, field(data, "sha"), isSha);
      const content = field(data, "content");
      // Files over 1 MB come back without their content.
      if (field(data, "encoding") !== "base64" || typeof content !== "string") {
        return { sha, text: null, problem: "too_large" };
      }
      const text = decodeBase64(content);
      return text === null ? { sha, text, problem: "binary" } : { sha, text, problem: null };
    },

    async getPull(n) {
      const call = repo("/pulls/:n", `/pulls/${checkNumber(n)}`);
      const answer = await request(call);
      const data = expectOk(call, answer);
      const headRepo = field(data, "head", "repo", "full_name");
      return {
        state: required(call, answer, field(data, "state"), isString),
        merged: field(data, "merged") === true,
        headRef: required(call, answer, field(data, "head", "ref"), isString),
        headRepo: typeof headRepo === "string" ? headRepo : null,
        baseRef: required(call, answer, field(data, "base", "ref"), isString),
      };
    },

    async createTree(baseTree, entries) {
      const call = repo("/git/trees", "/git/trees", "POST", {
        base_tree: checkSha(baseTree),
        tree: entries.map(checkEntry),
      });
      const answer = await request(call);
      return required(call, answer, field(expectOk(call, answer), "sha"), isSha);
    },

    async createCommit(commit) {
      const call = repo("/git/commits", "/git/commits", "POST", {
        message: commit.message,
        tree: checkSha(commit.tree),
        parents: commit.parents.map(checkSha),
        author: { name: commit.author.name, email: commit.author.email },
        committer: { name: commit.committer.name, email: commit.committer.email },
      });
      const answer = await request(call);
      return required(call, answer, field(expectOk(call, answer), "sha"), isSha);
    },

    async createRef(branch, sha) {
      const call = repo("/git/refs", "/git/refs", "POST", {
        ref: `refs/heads/${checkBranch(branch)}`,
        sha: checkSha(sha),
      });
      const answer = await request(call);
      if (answer.status === 422) return "exists";
      expectOk(call, answer);
      return "created";
    },

    async updateRef(branch, sha) {
      const call = repo(
        "/git/refs/heads/:branch",
        `/git/refs/heads/${encodePath(checkBranch(branch))}`,
        "PATCH",
        { sha: checkSha(sha), force: false },
      );
      const answer = await request(call);
      if (answer.status === 422) return "not_fast_forward";
      expectOk(call, answer);
      return "updated";
    },

    async deleteRef(branch) {
      const call = repo(
        "/git/refs/heads/:branch",
        `/git/refs/heads/${encodePath(checkBranch(branch))}`,
        "DELETE",
      );
      const answer = await request(call);
      // Already gone (404), or GitHub deleted it with the merge (422): nothing to do.
      if (answer.status === 404 || answer.status === 422) return;
      expectOk(call, answer);
    },

    async createPull(pull) {
      const call = repo("/pulls", "/pulls", "POST", {
        title: pull.title,
        head: checkBranch(pull.head),
        base: "main",
        body: pull.body,
      });
      const answer = await request(call);
      return required(call, answer, field(expectOk(call, answer), "number"), isPositive);
    },

    async updatePull(n, pull) {
      const body: Json = {};
      if (pull.title !== undefined) body.title = pull.title;
      if (pull.body !== undefined) body.body = pull.body;
      if (pull.state !== undefined) body.state = pull.state;
      const call = repo("/pulls/:n", `/pulls/${checkNumber(n)}`, "PATCH", body);
      const answer = await request(call);
      if (answer.status === 422) return { ok: false, status: 422 };
      const data = expectOk(call, answer);
      return {
        ok: true,
        state: required(call, answer, field(data, "state"), isString),
        merged: field(data, "merged") === true,
      };
    },

    async createComment(n, body) {
      const call = repo("/issues/:n/comments", `/issues/${checkNumber(n)}/comments`, "POST", {
        body,
      });
      expectOk(call, await request(call));
    },

    async deployRuns(sha) {
      // deploy.yml by name: ci.yml runs on pushes to main too.
      const call = repo(
        "/actions/workflows/deploy.yml/runs",
        `/actions/workflows/deploy.yml/runs?head_sha=${checkSha(sha)}&event=push&per_page=5`,
      );
      const answer = await request(call);
      const runs = field(expectOk(call, answer), "workflow_runs");
      if (!Array.isArray(runs)) throw new GitHubError(answer.status, `GET ${call.route}`);
      const run: unknown = runs[0];
      if (run === undefined) return null;
      const conclusion = field(run, "conclusion");
      return {
        status: required(call, answer, field(run, "status"), isString),
        conclusion: typeof conclusion === "string" ? conclusion : null,
        html_url: required(call, answer, field(run, "html_url"), isString),
      };
    },

    async compare(baseSha, headSha) {
      const call = repo(
        "/compare/:base...:head",
        `/compare/${checkSha(baseSha)}...${checkSha(headSha)}?per_page=1`,
      );
      const answer = await request(call);
      return required(call, answer, field(expectOk(call, answer), "status"), isString);
    },

    async postsTree() {
      const oid = field(await graphql("PostsTree"), "object", "oid");
      return typeof oid === "string" ? oid : null;
    },

    async postsOnMain() {
      const tree = field(await graphql("PostsOnMain"), "object");
      const oid = field(tree, "oid");
      const entries = field(tree, "entries");
      if (typeof oid !== "string" || !Array.isArray(entries)) return null;
      return {
        oid,
        entries: entries.flatMap((entry): PostsTreeEntry[] => {
          const name = field(entry, "name");
          const type = field(entry, "type");
          const entryOid = field(entry, "oid");
          if (typeof name !== "string" || typeof type !== "string" || !isGitSha(entryOid)) {
            return [];
          }
          const blob = field(entry, "object");
          const text = field(blob, "text");
          const byteSize = field(blob, "byteSize");
          return [
            {
              name,
              type,
              oid: entryOid,
              object: isObject(blob)
                ? {
                    byteSize: typeof byteSize === "number" ? byteSize : 0,
                    isBinary: field(blob, "isBinary") === true,
                    isTruncated: field(blob, "isTruncated") === true,
                    text: typeof text === "string" ? text : null,
                  }
                : null,
            },
          ];
        }),
      };
    },

    async openPullHeads() {
      const heads: OpenPullHead[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PULL_PAGES; page++) {
        const pulls = field(await graphql("OpenPullHeads", { after }), "pullRequests");
        const nodes = field(pulls, "nodes");
        if (!Array.isArray(nodes)) throw new GitHubError(200, "POST /graphql OpenPullHeads");
        for (const node of nodes) {
          const number = field(node, "number");
          const headRefName = field(node, "headRefName");
          if (!isPositive(number) || typeof headRefName !== "string") continue;
          heads.push({
            number,
            headRefName,
            // Unknown counts as this repo's, so a collision is never missed.
            isCrossRepository: field(node, "isCrossRepository") === true,
          });
        }
        const next = field(pulls, "pageInfo", "endCursor");
        if (field(pulls, "pageInfo", "hasNextPage") !== true || typeof next !== "string") break;
        after = next;
      }
      return heads;
    },

    async publishStatus(query) {
      checkNumber(query.number);
      checkSha(query.head);
      if (!isPostPath(query.path)) throw invalidInput();
      const repository = await graphql("PublishStatus", {
        number: query.number,
        head: query.head,
        path: query.path,
      });
      const operation = "POST /graphql PublishStatus";
      const pull = field(repository, "pullRequest");
      const ci = ciRun(field(repository, "object", "checkSuites", "nodes"));
      if (pull === null || pull === undefined) return { pullRequest: null, ci };
      const state = field(pull, "state");
      const headRefName = field(pull, "headRefName");
      const headRefOid = field(pull, "headRefOid");
      const baseRefName = field(pull, "baseRefName");
      if (
        (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
        typeof headRefName !== "string" ||
        typeof headRefOid !== "string" ||
        typeof baseRefName !== "string"
      ) {
        throw new GitHubError(200, operation);
      }
      const headRepository = field(pull, "headRepository", "nameWithOwner");
      const merge = field(pull, "mergeCommit");
      let mergeCommit: NonNullable<PullRequestStatus["pullRequest"]>["mergeCommit"] = null;
      if (isObject(merge)) {
        const mergeOid = field(merge, "oid");
        if (typeof mergeOid !== "string") throw new GitHubError(200, operation);
        const file = field(merge, "file");
        const fileOid = field(file, "oid");
        const text = field(file, "object", "text");
        mergeCommit = {
          oid: mergeOid,
          file: isObject(file)
            ? {
                oid: typeof fileOid === "string" ? fileOid : "",
                text: typeof text === "string" ? text : null,
                isTruncated: field(file, "object", "isTruncated") === true,
              }
            : null,
        };
      }
      return {
        pullRequest: {
          state,
          merged: field(pull, "merged") === true,
          headRefName,
          headRefOid,
          baseRefName,
          headRepository: typeof headRepository === "string" ? headRepository : null,
          mergeCommit,
        },
        ci,
      };
    },

    async botIdentity() {
      const cached = bots.get(cacheKey);
      if (cached) return cached;
      // The token first, so a refused mint stops the flow before anything else.
      await installationToken();
      const appCall: Call = { method: "GET", route: "/app", path: "/app", auth: "jwt" };
      const app = await request(appCall);
      const slug = required(
        appCall,
        app,
        field(expectOk(appCall, app), "slug"),
        (v): v is string => typeof v === "string" && APP_SLUG.test(v),
      );
      const login = `${slug}[bot]`;
      const userCall: Call = {
        method: "GET",
        route: "/users/:login",
        path: `/users/${encodeURIComponent(login)}`,
        auth: "token",
      };
      const user = await request(userCall);
      const id = required(userCall, user, field(expectOk(userCall, user), "id"), isPositive);
      const identity = { name: login, email: `${id}+${login}@users.noreply.github.com` };
      bots.set(cacheKey, identity);
      return identity;
    },

    async liveVersion() {
      if (!stub) return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
      const call: Call = {
        method: "GET",
        route: "/__e2e/health",
        path: "/__e2e/health",
        auth: "none",
      };
      const answer = await request(call);
      return required(call, answer, field(expectOk(call, answer), "version"), isString);
    },
  };
}
