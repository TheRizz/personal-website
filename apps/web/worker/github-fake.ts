import { jwtVerify } from "jose";
import { gitBlobSha } from "../app/lib/publish/git-blob";
import { containsOwnerEmail } from "./github";

// A GitHub for unit tests, behind a `fetch` the client is given (like d1-fake.ts for D1). It keeps
// a small git model (blobs by their real SHA, trees as path maps, commits, refs) and pull
// requests with their checks, and records every request. Only the routes the client may call
// (contract §5.3) exist: anything else is answered 501 and recorded with `route: null`, and a
// GraphQL mutation is answered 500, so a test can prove the client never asks for them. As on
// GitHub, a PR's head lags a push to its branch: the next read of the PR still shows the old one.

export interface RecordedRequest {
  method: string;
  url: string;
  /** Path and query, without the origin. */
  path: string;
  /** The route template it matched, or null (answered 501). */
  route: string | null;
  headers: Record<string, string>;
  /** The raw request body, or null. */
  text: string | null;
  /** The body parsed as JSON, or undefined. */
  body: unknown;
  operationName?: string;
  redirect?: RequestRedirect;
  hasSignal: boolean;
}

interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: unknown;
  committer: unknown;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  headSha: string;
  /** `main` when the PR was opened: a squash merge applies the branch's changes against it. */
  baseSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  headRepo: string;
  comments: string[];
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

const REPO = "/repos/TheRizz/personal-website";
const ROUTES: [string, string, RegExp][] = [
  ["POST", "/app/installations/:id/access_tokens", /^\/app\/installations\/(\d+)\/access_tokens$/],
  ["GET", "/app", /^\/app$/],
  ["GET", "/users/:login", /^\/users\/([^/]+)$/],
  ["POST", "/graphql", /^\/graphql$/],
  ["GET", "/__e2e/health", /^\/__e2e\/health$/],
  ["GET", "/repos/:repo/git/ref/heads/:branch", /^\/git\/ref\/heads\/(.+)$/],
  ["GET", "/repos/:repo/git/commits/:sha", /^\/git\/commits\/([0-9a-f]{40})$/],
  ["GET", "/repos/:repo/contents/:path", /^\/contents\/(.+)$/],
  ["GET", "/repos/:repo/pulls/:n", /^\/pulls\/(\d+)$/],
  ["POST", "/repos/:repo/git/trees", /^\/git\/trees$/],
  ["POST", "/repos/:repo/git/commits", /^\/git\/commits$/],
  ["POST", "/repos/:repo/git/refs", /^\/git\/refs$/],
  ["PATCH", "/repos/:repo/git/refs/heads/:branch", /^\/git\/refs\/heads\/(.+)$/],
  ["DELETE", "/repos/:repo/git/refs/heads/:branch", /^\/git\/refs\/heads\/(.+)$/],
  ["POST", "/repos/:repo/pulls", /^\/pulls$/],
  ["PATCH", "/repos/:repo/pulls/:n", /^\/pulls\/(\d+)$/],
  ["POST", "/repos/:repo/issues/:n/comments", /^\/issues\/(\d+)\/comments$/],
  [
    "GET",
    "/repos/:repo/actions/workflows/deploy.yml/runs",
    /^\/actions\/workflows\/deploy\.yml\/runs$/,
  ],
  ["GET", "/repos/:repo/compare/:base...:head", /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/],
];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ message: "Not Found" }, 404);

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** UTF-8 text as GitHub's contents API sends it: base64, wrapped at 60 columns. */
function base64Wrapped(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (btoa(binary).match(/.{1,60}/g) ?? []).join("\n") + "\n";
}

export const FAKE_APP_SLUG = "fake-publisher";
export const FAKE_BOT_ID = 4242;
export const FAKE_INSTALLATION_ID = "4242";
export const FAKE_CLIENT_ID = "Iv-fake-client";

/**
 * A fresh fake whose `main` holds `files`. `publicKey` verifies App JWTs; `now` is its clock for
 * token expiry.
 */
export async function createGitHubFake(options: {
  publicKey: CryptoKey;
  files?: Record<string, string>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, FakeCommit>();
  const refs = new Map<string, string>();
  const pulls = new Map<number, FakePull>();
  /** PR number → the head its branch moved to, which the PR shows after its next read. */
  const pendingHeads = new Map<number, string>();
  /** Check suites per head SHA, as PublishStatus returns them. */
  const checks = new Map<string, unknown[]>();
  /** Deploy runs per SHA, newest first. */
  const deploys = new Map<
    string,
    { status: string; conclusion: string | null; html_url: string }[]
  >();
  const tokens = new Set<string>();
  const requests: RecordedRequest[] = [];
  const overrides: { method: string; route: string; respond: Responder; times: number }[] = [];
  let commitCount = 0;
  let tokenCount = 0;
  let nextPull = 1;

  const fake = {
    requests,
    pulls,
    refs,
    commits,
    /** The version `/__e2e/health` reports. */
    version: "dev",
    /** Open PRs from elsewhere (forks, other branches) that OpenPullHeads lists too. */
    otherPulls: [] as { number: number; headRefName: string; isCrossRepository: boolean }[],
    /** OpenPullHeads page size. */
    pageSize: 100,
    /** Answer every GraphQL query with `repository: null` (the App lost access). */
    repositoryGone: false,
    /** Paths whose contents come back without content (over 1 MB) or truncated in GraphQL. */
    largeFiles: new Set<string>(),
    /** Paths GraphQL reports as binary. */
    binaryFiles: new Set<string>(),
    /** Edits the token grant before it is sent. */
    grant: (grant: Record<string, unknown>) => grant,
    /** The token mint's `expires_at`, as milliseconds from now. */
    tokenLifetime: 60 * 60 * 1000,

    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = (init.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const text = typeof init.body === "string" ? init.body : null;
      let body: unknown;
      try {
        body = text === null ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const relative = url.pathname.startsWith(REPO) ? url.pathname.slice(REPO.length) : null;
      const match = ROUTES.map(([m, route, pattern]) => {
        if (m !== method) return null;
        const subject = route.startsWith("/repos/") ? relative : url.pathname;
        const found = subject === null ? null : pattern.exec(subject);
        return found ? { route, params: found.slice(1).map(decodeURIComponent) } : null;
      }).find((found) => found !== null);
      const operationName =
        typeof body === "object" && body !== null && "operationName" in body
          ? String((body as { operationName: unknown }).operationName)
          : undefined;
      const recorded: RecordedRequest = {
        method,
        url: url.href,
        path: url.pathname + url.search,
        route: match?.route ?? null,
        headers,
        text,
        body,
        ...(operationName !== undefined && { operationName }),
        redirect: init.redirect,
        hasSignal: init.signal instanceof AbortSignal,
      };
      requests.push(recorded);
      if (!match) return json({ message: "Not implemented in the fake" }, 501);

      const override = overrides.find((o) => o.method === method && o.route === match.route);
      if (override) {
        if (--override.times <= 0) overrides.splice(overrides.indexOf(override), 1);
        return override.respond(recorded);
      }
      return handle(recorded, match.route, match.params, url);
    }) as typeof fetch,

    /** Answers the next `times` requests to `route` with `respond` instead. */
    override(method: string, route: string, respond: Responder | Response, times = 1) {
      const responder: Responder = respond instanceof Response ? () => respond.clone() : respond;
      overrides.push({ method, route, respond: responder, times });
    },

    /** Makes every issued token invalid, as if it had expired early. */
    revokeTokens() {
      tokens.clear();
    },

    /** The text of every file on `main`. */
    mainFiles(): Map<string, string> {
      return filesAt(refs.get("main") ?? "");
    },

    /** The text of every file at a commit. */
    filesAt,

    /** Writes (or, with null, deletes) a file on `main` as a direct commit. */
    async setMainFile(path: string, content: string | null): Promise<string> {
      const parent = refs.get("main")!;
      const files = new Map(treeOf(parent));
      if (content === null) files.delete(path);
      else files.set(path, await addBlob(content));
      const sha = await addCommit(await addTree(files), [parent], "direct change");
      refs.set("main", sha);
      return sha;
    },

    /** Squash and merge: the branch's changes against its base applied to `main`, as one commit. */
    async mergePull(n: number): Promise<string> {
      const pull = pulls.get(n);
      if (!pull || pull.state !== "open") throw new Error("not an open pull request");
      catchUp(pull);
      const before = treeOf(pull.baseSha);
      const after = treeOf(pull.headSha);
      const files = new Map(treeOf(refs.get("main")!));
      for (const [path, blob] of after) if (before.get(path) !== blob) files.set(path, blob);
      for (const path of before.keys()) if (!after.has(path)) files.delete(path);
      const sha = await addCommit(await addTree(files), [refs.get("main")!], pull.title);
      refs.set("main", sha);
      refs.delete(pull.head);
      Object.assign(pull, { state: "closed", merged: true, mergeSha: sha });
      return sha;
    },

    /** Closes a PR without merging, as the owner might on GitHub. */
    closePull(n: number) {
      const pull = pulls.get(n);
      if (pull) pull.state = "closed";
    },

    /** Sets the `ci` run of a head commit (one GitHub Actions suite). */
    setCi(
      sha: string,
      run: { status: string; conclusion?: string | null; detailsUrl?: string | null } | null,
      extra: { createdAt?: string; appSlug?: string } = {},
    ) {
      const suites = checks.get(sha) ?? [];
      suites.push({
        createdAt: extra.createdAt ?? new Date(now()).toISOString(),
        app: { slug: extra.appSlug ?? "github-actions" },
        checkRuns: {
          nodes: run
            ? [
                {
                  status: run.status,
                  conclusion: run.conclusion ?? null,
                  detailsUrl:
                    run.detailsUrl === undefined
                      ? "https://github.com/TheRizz/personal-website/actions/runs/1/job/2"
                      : run.detailsUrl,
                },
              ]
            : [],
        },
      });
      checks.set(sha, suites);
    },

    /** Adds a `deploy.yml` run for `sha`; the newest is listed first. */
    addDeploy(sha: string, status: string, conclusion: string | null = null, id = 99) {
      const runs = deploys.get(sha) ?? [];
      runs.unshift({
        status,
        conclusion,
        html_url: `https://github.com/TheRizz/personal-website/actions/runs/${id}`,
      });
      deploys.set(sha, runs);
    },

    /** Opens a PR straight on the fake, as someone else might. */
    async openPullFrom(branch: string, files: Record<string, string>, title = "Someone's PR") {
      const base = refs.get("main")!;
      const tree = new Map(treeOf(base));
      for (const [path, content] of Object.entries(files)) tree.set(path, await addBlob(content));
      const head = await addCommit(await addTree(tree), [base], title);
      refs.set(branch, head);
      return openPull(title, "", branch, head);
    },

    /** Requests that wrote to the repository. */
    writes(): RecordedRequest[] {
      return requests.filter(
        (r) => r.method !== "GET" && r.path.startsWith(REPO) && r.route !== null,
      );
    },
  };

  function treeOf(commitSha: string): Map<string, string> {
    const commit = commits.get(commitSha);
    return (commit && trees.get(commit.tree)) ?? new Map();
  }

  function filesAt(commitSha: string): Map<string, string> {
    return new Map([...treeOf(commitSha)].map(([path, blob]) => [path, blobs.get(blob) ?? ""]));
  }

  async function addBlob(content: string): Promise<string> {
    const sha = await gitBlobSha(content);
    blobs.set(sha, content);
    return sha;
  }

  /** Trees are content-addressed, like git's, so equal trees get equal OIDs. */
  async function addTree(files: Map<string, string>): Promise<string> {
    const lines = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, b]) => `${p}\0${b}`);
    const sha = await sha1(`tree\n${lines.join("\n")}`);
    trees.set(sha, new Map(files));
    return sha;
  }

  async function addCommit(
    tree: string,
    parents: string[],
    message: string,
    author: unknown = null,
    committer: unknown = null,
  ): Promise<string> {
    const sha = await sha1(`commit ${++commitCount} ${tree} ${message}`);
    commits.set(sha, { sha, tree, parents, message, author, committer });
    return sha;
  }

  /** GitHub's background job after a push: the PR's head becomes its branch's. */
  function catchUp(pull: FakePull): void {
    const head = pendingHeads.get(pull.number);
    if (head === undefined) return;
    pull.headSha = head;
    pendingHeads.delete(pull.number);
  }

  function openPull(title: string, body: string, head: string, headSha: string): FakePull {
    const pull: FakePull = {
      number: nextPull++,
      title,
      body,
      head,
      headSha,
      baseSha: refs.get("main")!,
      state: "open",
      merged: false,
      mergeSha: null,
      headRepo: "TheRizz/personal-website",
      comments: [],
    };
    pulls.set(pull.number, pull);
    return pull;
  }

  /** The OID of `main:content/blog`, from its direct children. */
  async function blogTreeOid(): Promise<string | null> {
    const entries = [...treeOf(refs.get("main") ?? "")].filter(([path]) =>
      /^content\/blog\/[^/]+$/.test(path),
    );
    if (entries.length === 0) return null;
    return sha1(`blog\n${entries.map(([p, b]) => `${p}\0${b}`).join("\n")}`);
  }

  function isAncestor(ancestor: string, of: string): boolean {
    const seen = new Set<string>();
    const queue = [of];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  async function verifyJwt(request: RecordedRequest): Promise<boolean> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!token) return false;
    try {
      await jwtVerify(token, options.publicKey, {
        algorithms: ["RS256"],
        issuer: FAKE_CLIENT_ID,
        currentDate: new Date(now()),
      });
      return true;
    } catch {
      return false;
    }
  }

  const hasToken = (request: RecordedRequest) =>
    tokens.has(/^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");

  async function handle(
    request: RecordedRequest,
    route: string,
    params: string[],
    url: URL,
  ): Promise<Response> {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (route === "/__e2e/health") return json({ ok: true, version: fake.version });
    if (route === "/app/installations/:id/access_tokens" || route === "/app") {
      if (!(await verifyJwt(request))) return json({ message: "Bad credentials" }, 401);
      if (route === "/app") return json({ slug: FAKE_APP_SLUG });
      if (params[0] !== FAKE_INSTALLATION_ID) return notFound();
      const token = `ghs_fake_${++tokenCount}`;
      tokens.add(token);
      const permissions = (body.permissions ?? {}) as Record<string, string>;
      return json(
        fake.grant({
          token,
          expires_at: new Date(now() + fake.tokenLifetime).toISOString(),
          repository_selection: "selected",
          permissions: { ...permissions, metadata: "read" },
          repositories: [{ name: "personal-website" }],
        }),
        201,
      );
    }
    if (!hasToken(request)) return json({ message: "Bad credentials" }, 401);

    const [first = "", second = ""] = params;
    switch (route) {
      case "/users/:login":
        return first === `${FAKE_APP_SLUG}[bot]`
          ? json({ login: first, id: FAKE_BOT_ID })
          : notFound();
      case "/graphql":
        return graphql(body);
      case "/repos/:repo/git/ref/heads/:branch": {
        const sha = refs.get(first);
        return sha
          ? json({ ref: `refs/heads/${first}`, object: { sha, type: "commit" } })
          : notFound();
      }
      case "/repos/:repo/git/commits/:sha": {
        const commit = commits.get(first);
        if (!commit) return notFound();
        return json({ sha: commit.sha, tree: { sha: commit.tree }, parents: commit.parents });
      }
      case "/repos/:repo/contents/:path": {
        const ref = url.searchParams.get("ref") ?? "main";
        const commit = refs.get(ref) ?? ref;
        const blob = treeOf(commit).get(first);
        if (!blob) return notFound();
        if (fake.largeFiles.has(first)) {
          return json({ type: "file", path: first, sha: blob, encoding: "none", content: "" });
        }
        return json({
          type: "file",
          path: first,
          sha: blob,
          encoding: "base64",
          content: base64Wrapped(blobs.get(blob) ?? ""),
        });
      }
      case "/repos/:repo/pulls/:n": {
        const pull = pulls.get(Number(first));
        if (!pull) return notFound();
        if (request.method === "PATCH") {
          if (body.state === "closed" && pull.merged) return json({ message: "merged" }, 422);
          if (typeof body.title === "string") pull.title = body.title;
          if (typeof body.body === "string") pull.body = body.body;
          if (body.state === "closed") pull.state = "closed";
          return json(pullJson(pull));
        }
        const answer = json(pullJson(pull));
        catchUp(pull);
        return answer;
      }
      case "/repos/:repo/git/trees": {
        const base = trees.get(String(body.base_tree));
        if (!base) return json({ message: "base_tree not found" }, 422);
        const files = new Map(base);
        for (const entry of (body.tree ?? []) as Record<string, unknown>[]) {
          const path = String(entry.path);
          if (typeof entry.content === "string") files.set(path, await addBlob(entry.content));
          else if (entry.sha === null) {
            if (!files.has(path)) return json({ message: "path not in tree" }, 422);
            files.delete(path);
          }
        }
        return json({ sha: await addTree(files) }, 201);
      }
      case "/repos/:repo/git/commits": {
        const tree = String(body.tree);
        const parents = (body.parents ?? []) as string[];
        if (!trees.has(tree) || !parents.every((p) => commits.has(p))) {
          return json({ message: "unknown tree or parent" }, 422);
        }
        const sha = await addCommit(
          tree,
          parents,
          String(body.message),
          body.author,
          body.committer,
        );
        return json({ sha }, 201);
      }
      case "/repos/:repo/git/refs": {
        const ref = String(body.ref);
        if (!ref.startsWith("refs/heads/blog/")) return json({ message: "bot scope" }, 403);
        const branch = ref.slice("refs/heads/".length);
        if (refs.has(branch)) return json({ message: "Reference already exists" }, 422);
        if (!commits.has(String(body.sha))) return json({ message: "unknown sha" }, 422);
        refs.set(branch, String(body.sha));
        return json({ ref, object: { sha: body.sha } }, 201);
      }
      case "/repos/:repo/git/refs/heads/:branch": {
        if (request.method === "DELETE") {
          if (!refs.delete(first)) return json({ message: "Reference does not exist" }, 422);
          return new Response(null, { status: 204 });
        }
        const current = refs.get(first);
        const next = commits.get(String(body.sha));
        if (!current || !next) return json({ message: "unknown ref" }, 422);
        if (body.force !== false || !isAncestor(current, next.sha)) {
          return json({ message: "Update is not a fast forward" }, 422);
        }
        refs.set(first, next.sha);
        for (const pull of pulls.values()) {
          if (pull.head === first && pull.state === "open") pendingHeads.set(pull.number, next.sha);
        }
        return json({ ref: `refs/heads/${first}`, object: { sha: next.sha } });
      }
      case "/repos/:repo/pulls": {
        const head = String(body.head);
        const headSha = refs.get(head);
        if (!headSha || body.base !== "main") return json({ message: "Validation Failed" }, 422);
        const pull = openPull(String(body.title), String(body.body), head, headSha);
        return json(
          { ...pullJson(pull), html_url: `https://github.com${REPO}/pull/${pull.number}` },
          201,
        );
      }
      case "/repos/:repo/issues/:n/comments": {
        const pull = pulls.get(Number(first));
        if (!pull) return notFound();
        pull.comments.push(String(body.body));
        return json({ id: pull.comments.length }, 201);
      }
      case "/repos/:repo/actions/workflows/deploy.yml/runs": {
        const runs = deploys.get(url.searchParams.get("head_sha") ?? "") ?? [];
        return json({ total_count: runs.length, workflow_runs: runs.slice(0, 5) });
      }
      case "/repos/:repo/compare/:base...:head": {
        if (!commits.has(first) || !commits.has(second)) return notFound();
        const status =
          first === second
            ? "identical"
            : isAncestor(first, second)
              ? "ahead"
              : isAncestor(second, first)
                ? "behind"
                : "diverged";
        return json({ status });
      }
    }
    return json({ message: "Not implemented in the fake" }, 501);
  }

  function pullJson(pull: FakePull) {
    return {
      number: pull.number,
      state: pull.state,
      merged: pull.merged,
      head: { ref: pull.head, sha: pull.headSha, repo: { full_name: pull.headRepo } },
      base: { ref: "main" },
    };
  }

  async function graphql(body: Record<string, unknown>): Promise<Response> {
    const query = String(body.query ?? "");
    if (/\bmutation\b/i.test(query)) return json({ message: "mutations are refused" }, 500);
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    if (fake.repositoryGone) {
      return json({ data: { repository: null }, errors: [{ type: "NOT_FOUND" }] });
    }
    const main = refs.get("main") ?? "";
    switch (body.operationName) {
      case "PostsTree": {
        const oid = await blogTreeOid();
        return json({ data: { repository: { object: oid ? { oid } : null } } });
      }
      case "PostsOnMain": {
        const oid = await blogTreeOid();
        if (!oid) return json({ data: { repository: { object: null } } });
        const entries = [...treeOf(main)]
          .filter(([path]) => /^content\/blog\/[^/]+$/.test(path))
          .map(([path, blob]) => {
            const text = blobs.get(blob) ?? "";
            const large = fake.largeFiles.has(path);
            const binary = fake.binaryFiles.has(path);
            return {
              name: path.slice("content/blog/".length),
              type: "blob",
              oid: blob,
              object: {
                byteSize: new TextEncoder().encode(text).byteLength,
                isBinary: binary,
                isTruncated: large,
                text: binary ? null : large ? text.slice(0, 10) : text,
              },
            };
          });
        return json({ data: { repository: { object: { oid, entries } } } });
      }
      case "OpenPullHeads": {
        const all = [
          ...[...pulls.values()]
            .filter((pull) => pull.state === "open")
            .map((pull) => ({
              number: pull.number,
              headRefName: pull.head,
              isCrossRepository: pull.headRepo !== "TheRizz/personal-website",
            })),
          ...fake.otherPulls,
        ];
        const start = variables.after ? Number(variables.after) : 0;
        const nodes = all.slice(start, start + fake.pageSize);
        const end = start + nodes.length;
        return json({
          data: {
            repository: {
              pullRequests: {
                nodes,
                pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
              },
            },
          },
        });
      }
      case "PublishStatus": {
        const pull = pulls.get(Number(variables.number));
        const head = commits.has(String(variables.head))
          ? { checkSuites: { nodes: checks.get(String(variables.head)) ?? [] } }
          : null;
        if (!pull) {
          return json({
            data: { repository: { pullRequest: null, object: head } },
            errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"] }],
          });
        }
        let mergeCommit = null;
        if (pull.mergeSha) {
          const path = String(variables.path);
          const blob = treeOf(pull.mergeSha).get(path);
          const text = blob ? (blobs.get(blob) ?? "") : "";
          const large = fake.largeFiles.has(path);
          mergeCommit = {
            oid: pull.mergeSha,
            file: blob
              ? {
                  oid: blob,
                  object: { text: large ? text.slice(0, 10) : text, isTruncated: large },
                }
              : null,
          };
        }
        const answer = json({
          data: {
            repository: {
              pullRequest: {
                state: pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED",
                merged: pull.merged,
                headRefName: pull.head,
                headRefOid: pull.headSha,
                baseRefName: "main",
                headRepository: { nameWithOwner: pull.headRepo },
                mergeCommit,
              },
              object: head,
            },
          },
        });
        catchUp(pull);
        return answer;
      }
    }
    return json({ message: "unknown operation" }, 501);
  }

  // `main` starts with the given files.
  const start = new Map<string, string>();
  for (const [path, content] of Object.entries(options.files ?? {})) {
    start.set(path, await addBlob(content));
  }
  refs.set("main", await addCommit(await addTree(start), [], "initial"));
  return fake;
}

export type GitHubFake = Awaited<ReturnType<typeof createGitHubFake>>;

/**
 * What a test must never see in any request: a route outside the allowlist, a GraphQL mutation,
 * a merge endpoint, or the owner's address or any of `forbidden` (draft ids, another draft's
 * text) in its URL, headers or body. Returns one line per problem.
 */
export function auditRequests(
  requests: RecordedRequest[],
  check: { ownerEmail: string; forbidden?: string[] },
): string[] {
  const problems: string[] = [];
  for (const request of requests) {
    const where = `${request.method} ${request.route ?? request.path}`;
    const texts = [request.url, JSON.stringify(request.headers), request.text ?? ""];
    if (request.route === null) problems.push(`unknown route: ${request.method} ${request.path}`);
    if (request.route === "/graphql" && /\bmutation\b/i.test(request.text ?? "")) {
      problems.push(`GraphQL mutation: ${where}`);
    }
    if (/\/pulls\/\d+\/merge$|\/merges$/.test(new URL(request.url).pathname)) {
      problems.push(`merge endpoint: ${where}`);
    }
    if (texts.some((text) => containsOwnerEmail(text, check.ownerEmail))) {
      problems.push(`owner e-mail in ${where}`);
    }
    for (const value of check.forbidden ?? []) {
      if (texts.some((text) => text.includes(value))) problems.push(`forbidden value in ${where}`);
    }
  }
  return problems;
}
