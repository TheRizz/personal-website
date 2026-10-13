import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as githubModule from "./github";
import {
  GitHubError,
  GitHubUnavailable,
  OwnerEmailInBody,
  assertQuery,
  containsOwnerEmail,
  createGitHub,
  resetGitHubCaches,
  type GitHubEnv,
} from "./github";
import {
  FAKE_CLIENT_ID,
  FAKE_INSTALLATION_ID,
  auditRequests,
  createGitHubFake,
  type GitHubFake,
} from "./github-fake";

// The GitHub client against the recording fake (github-fake.ts): configuration guards, the
// App JWT and installation token, the request rules, input checks and the four GraphQL queries.

const OWNER = "owner@example.com";
const SITE = "https://ry-mart.com/api/admin/posts";
const LOCAL = "http://localhost:4173/api/admin/posts";
const POST = "content/blog/2026-10-11-hello-world.md";
const SHA = "a".repeat(40);
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

/** The part of node:crypto the fixtures use; the Worker's tsconfig has no Node types. */
interface CryptoModule {
  createPrivateKey(pem: string): {
    export(options: {
      type: "pkcs1" | "pkcs8";
      format: "pem";
      cipher?: string;
      passphrase?: string;
    }): string;
  };
}

let publicKey: CryptoKey;
let pem: string;
/** The same key as GitHub downloads it (PKCS#1), and encrypted with a throwaway passphrase. */
let pkcs1: string;
let encrypted: string;
let fake: GitHubFake;
let clock: number;
const now = () => clock;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  pem = await exportPKCS8(pair.privateKey);
  const { createPrivateKey } = (await import("node:crypto" as string)) as CryptoModule;
  pkcs1 = createPrivateKey(pem).export({ type: "pkcs1", format: "pem" });
  encrypted = createPrivateKey(pem).export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: "throwaway",
  });
});

beforeEach(async () => {
  resetGitHubCaches();
  clock = T0;
  fake = await createGitHubFake({ publicKey, now, files: { [POST]: "---\ntitle: x\n---\n" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  expect(auditRequests(fake.requests, { ownerEmail: OWNER })).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(extra: Partial<GitHubEnv> = {}): GitHubEnv {
  return {
    OWNER_EMAIL: OWNER,
    GIT_AUTHOR: "TheRizz <19941577+TheRizz@users.noreply.github.com>",
    GITHUB_APP_CLIENT_ID: FAKE_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: FAKE_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: pem,
    ...extra,
  };
}

const client = (extra: Partial<GitHubEnv> = {}, url = SITE) =>
  createGitHub(env(extra), url, { fetch: fake.fetch, now });

/** The error `run` throws (or rejects with). */
async function failure(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const routes = () => fake.requests.map((r) => `${r.method} ${r.route}`);

describe("containsOwnerEmail", () => {
  const zwsp = String.fromCodePoint(0x200b);
  const shy = String.fromCodePoint(0xad);
  it.each([
    "owner@example.com",
    "Write to OWNER@Example.COM today",
    "owner\\@example.com",
    "owner\\@example\\.com",
    "owner&#64;example.com",
    "owner&#x40;example.com",
    "owner&#X0040;example.com",
    "owner&commat;example&period;com",
    "mailto:owner%40example.com",
    "owner%2540example.com",
    "owner&amp;#64;example.com",
    `owner@${zwsp}example.com`,
    `own${shy}er@example.com`,
    "owner＠example.com",
  ])("finds %j", (text) => {
    expect(containsOwnerEmail(text, OWNER)).toBe(true);
  });

  it.each(["owner@example.org", "someone@example.com", "owner at example dot com", "%E0%A4%A"])(
    "doesn't find %j",
    (text) => {
      expect(containsOwnerEmail(text, OWNER)).toBe(false);
    },
  );
});

describe("configuration, checked before any request", () => {
  async function refused(extra: Partial<GitHubEnv>, url = SITE) {
    const error = await failure(() => client(extra, url));
    expect(fake.requests).toEqual([]);
    return error as GitHubUnavailable;
  }

  it.each([{ OWNER_EMAIL: "" }, { OWNER_EMAIL: "   " }, { OWNER_EMAIL: undefined }])(
    "refuses an empty OWNER_EMAIL %j",
    async (extra) => {
      expect(await refused(extra)).toMatchObject({
        code: "misconfigured",
        detail: "OWNER_EMAIL isn't set.",
      });
    },
  );

  it.each([
    "TheRizz <rizz@example.com>",
    "TheRizz",
    "owner@example.com <19941577+TheRizz@users.noreply.github.com>",
    "TheRizz <owner@example.com>",
  ])("refuses GIT_AUTHOR %j, naming the setting only", async (author) => {
    const error = await refused({ GIT_AUTHOR: author });
    expect(error).toMatchObject({
      code: "misconfigured",
      detail: expect.stringMatching(/^GIT_AUTHOR must be /),
    });
    expect(error.detail).not.toContain("example.com");
  });

  it("refuses a GIT_AUTHOR equal to the owner's address", async () => {
    const owner = "19941577+therizz@users.noreply.github.com";
    const error = await refused({
      OWNER_EMAIL: owner.toUpperCase(),
      GIT_AUTHOR: "TheRizz <19941577+TheRizz@users.noreply.github.com>",
    });
    expect(error).toMatchObject({
      code: "misconfigured",
      detail: expect.stringMatching(/^GIT_AUTHOR must be /),
    });
  });

  it("refuses GITHUB_API_BASE on the real host, with an alert", async () => {
    const error = await refused({ GITHUB_API_BASE: "http://127.0.0.1:5173" });
    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.code).toBe("github_unavailable");
    expect(console.error).toHaveBeenCalledWith(
      "ALERT: GITHUB_API_BASE is configured on ry-mart.com; refusing to publish",
    );
  });

  it.each([
    "https://evil.example",
    "http://127.0.0.1:1/x",
    "http://user:pass@127.0.0.1:1",
    "http://127.0.0.1:1/?q=1",
    "http://127.0.0.1:1/#x",
    "ftp://127.0.0.1",
    "not a url",
  ])("refuses the stub base %j even on localhost", async (base) => {
    const error = await refused({ GITHUB_API_BASE: base }, LOCAL);
    expect(error).toMatchObject({
      code: "misconfigured",
      detail: "GITHUB_API_BASE isn't a local origin.",
    });
  });

  it("refuses the e2e test key without the stub", async () => {
    const error = await refused({ ACCESS_TEST_JWKS: '{"keys":[]}' }, LOCAL);
    expect(error).toMatchObject({ code: "github_unavailable" });
    expect(console.error).toHaveBeenCalledWith(
      "ALERT: the e2e test key is configured without the GitHub stub; refusing to publish",
    );
  });

  const INSTALLATION_ID_HINT =
    "GITHUB_APP_INSTALLATION_ID must be the installation's number (the end of its settings URL).";

  it.each([
    [{ GITHUB_APP_INSTALLATION_ID: "12x" }, INSTALLATION_ID_HINT],
    [{ GITHUB_APP_INSTALLATION_ID: undefined }, INSTALLATION_ID_HINT],
    [{ GITHUB_APP_CLIENT_ID: " " }, "GITHUB_APP_CLIENT_ID isn't set."],
    [{ GITHUB_APP_PRIVATE_KEY: undefined }, "GITHUB_APP_PRIVATE_KEY isn't set."],
  ])("refuses missing secrets %j, logging and naming only the setting", async (extra, detail) => {
    expect(await refused(extra)).toMatchObject({ code: "misconfigured", detail });
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toMatch(/GITHUB_APP_/);
    expect(logged).not.toContain("PRIVATE KEY-----");
  });

  /** The base64 between a PEM's BEGIN and END lines, whitespace dropped. */
  const bodyOf = (key: string) => key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  /** The owner's hint for an unusable key: the value's shape (size, lines, header lines), never its text. */
  const unusableKey = (key: string, headers: string) => {
    const text = key.trim();
    const lines = text.split("\n").length;
    return (
      `GITHUB_APP_PRIVATE_KEY isn't a usable private key (${text.length} characters on ${lines} ` +
      `line${lines === 1 ? "" : "s"}, ${headers}); store the .pem exactly as downloaded.`
    );
  };

  it.each([
    ["an encrypted key", () => encrypted, "BEGIN ENCRYPTED PRIVATE KEY, END ENCRYPTED PRIVATE KEY"],
    [
      "a PKCS#8 key without its END line",
      () => "-----BEGIN PRIVATE KEY-----\nnope",
      "BEGIN PRIVATE KEY, no END line",
    ],
    [
      "a PKCS#1 key with its END line changed",
      () => pkcs1.replace("END RSA", "END"),
      "BEGIN RSA PRIVATE KEY, END PRIVATE KEY",
    ],
    [
      "a PKCS#1 key that isn't base64",
      () => pkcs1.replace(/\n[^-]/, "\n*"),
      "BEGIN RSA PRIVATE KEY, END RSA PRIVATE KEY",
    ],
    [
      "a PKCS#1 key with a character missing",
      () => pkcs1.replace(/\n[^-]/, "\n"),
      "BEGIN RSA PRIVATE KEY, END RSA PRIVATE KEY",
    ],
    [
      "an EC key",
      () => pkcs1.replace(/RSA PRIVATE/g, "EC PRIVATE"),
      "BEGIN EC PRIVATE KEY, END EC PRIVATE KEY",
    ],
    ["text that isn't a key", () => "not a key", "no BEGIN line, no END line"],
  ])(
    "refuses %s when it first signs, logging only the setting's name",
    async (_name, key, headers) => {
      const github = client({ GITHUB_APP_PRIVATE_KEY: key() });
      const error = await failure(() => github.getRef("main"));
      expect(error).toMatchObject({ code: "misconfigured", detail: unusableKey(key(), headers) });
      expect((error as GitHubUnavailable).detail).not.toContain(bodyOf(key()).slice(0, 24));
      expect(fake.requests).toEqual([]);
      expect(vi.mocked(console.error).mock.calls).toEqual([
        ["Publishing is misconfigured:", "GITHUB_APP_PRIVATE_KEY"],
      ]);
      const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
      expect(logged).not.toContain("PRIVATE KEY");
      expect(logged).not.toContain(bodyOf(key()).slice(0, 24));
    },
  );

  it("reads a key written on one line with literal \\n, as .dev.vars holds it", async () => {
    const github = client({ GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") });
    expect(await github.getRef("main")).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ["PKCS#1, as GitHub downloads it", () => pkcs1],
    ["PKCS#1 with CRLF line endings", () => pkcs1.replace(/\n/g, "\r\n")],
    ["PKCS#1 on one line with literal \\n", () => pkcs1.replace(/\n/g, "\\n")],
    ["PKCS#1 with whitespace around it", () => `\n  ${pkcs1}  \n`],
    ["PKCS#1 with spaces after its BEGIN line", () => pkcs1.replace("-----\n", "-----  \n")],
    ["PKCS#1 with its END line indented", () => pkcs1.replace("\n-----END", "\n  -----END")],
    ["PKCS#1 on one line (no line breaks)", () => pkcs1.replace(/\n/g, "")],
    ["PKCS#1 with spaces instead of line breaks", () => pkcs1.replace(/\n/g, " ")],
    ["PKCS#8", () => pem],
    ["PKCS#8 on one line", () => pem.replace(/\n/g, "")],
  ])("signs the App JWT with the key stored as %s", async (_name, key) => {
    const github = client({ GITHUB_APP_PRIVATE_KEY: key() });
    // The fake answers the mint only after verifying the JWT with the public key.
    expect(await github.getRef("main")).toMatch(/^[0-9a-f]{40}$/);
    const jwt = fake.requests[0]!.headers.authorization!.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(jwt, publicKey, { currentDate: new Date(T0) });
    expect(payload.iss).toBe(FAKE_CLIENT_ID);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("uses the local stub on localhost, and reads its live version", async () => {
    const github = createGitHub(env({ GITHUB_API_BASE: "http://127.0.0.1:5999" }), LOCAL, {
      fetch: fake.fetch,
      now,
    });
    fake.version = SHA;
    expect(await github.liveVersion()).toBe(SHA);
    expect(fake.requests.map((r) => r.url)).toEqual(["http://127.0.0.1:5999/__e2e/health"]);
  });

  it("reads the production live version in-process, with no request", async () => {
    const github = client();
    expect(await github.liveVersion()).toBe("dev");
    vi.stubGlobal("__APP_VERSION__", SHA);
    expect(await github.liveVersion()).toBe(SHA);
    expect(fake.requests).toEqual([]);
  });
});

describe("the App JWT and the installation token", () => {
  it("signs an RS256 JWT for the client id and mints a narrow token", async () => {
    await client().getRef("main");
    const [mint, ref] = fake.requests;
    expect(mint).toMatchObject({
      method: "POST",
      path: `/app/installations/${FAKE_INSTALLATION_ID}/access_tokens`,
      body: {
        repositories: ["personal-website"],
        permissions: {
          contents: "write",
          pull_requests: "write",
          actions: "read",
          checks: "read",
        },
      },
    });
    const jwt = mint!.headers.authorization!.replace(/^Bearer /, "");
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
    const { payload } = await jwtVerify(jwt, publicKey, { currentDate: new Date(T0) });
    expect(payload).toEqual({
      iss: FAKE_CLIENT_ID,
      iat: T0 / 1000 - 60,
      exp: T0 / 1000 + 540,
    });
    expect(ref!.headers.authorization).toBe("Bearer ghs_fake_1");
  });

  it("sends GitHub's headers, a timeout and no redirect following on every request", async () => {
    const github = client();
    await github.createTree(await mainTree(github), [
      { path: POST, mode: "100644", type: "blob", content: "x" },
    ]);
    for (const request of fake.requests) {
      expect(request.headers).toMatchObject({
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ry-mart-publisher",
      });
      expect(request.headers.authorization).toMatch(/^Bearer /);
      expect(request.redirect).toBe("manual");
      expect(request.hasSignal).toBe(true);
    }
    const post = fake.requests.at(-1)!;
    expect(post.headers["content-type"]).toBe("application/json");
    expect(fake.requests[1]!.headers["content-type"]).toBeUndefined();
  });

  it.each([
    ["repository_selection all", { repository_selection: "all" }, "repository_selection"],
    [
      "an extra workflows permission",
      { permissions: { contents: "write", workflows: "write" } },
      "permissions.workflows",
    ],
    ["an admin level", { permissions: { contents: "admin" } }, "permissions.contents"],
    ["write where read was asked", { permissions: { checks: "write" } }, "permissions.checks"],
    [
      "two repositories",
      { repositories: [{ name: "personal-website" }, { name: "other" }] },
      "repositories",
    ],
    ["another repository", { repositories: [{ name: "other" }] }, "repositories"],
  ])("fails closed on a token with %s, naming the problem", async (_name, change, problem) => {
    fake.grant = (grant) => ({ ...grant, ...change });
    const error = await failure(() => client().getRef("main"));
    expect(error).toMatchObject({
      code: "misconfigured",
      detail: expect.stringContaining(
        `publishing may use (${problem}): install it on personal-website only, with exactly`,
      ),
    });
    expect(routes()).toEqual(["POST /app/installations/:id/access_tokens"]);
  });

  it("accepts a token narrower than asked, and metadata read", async () => {
    fake.grant = (grant) => ({
      ...grant,
      permissions: { contents: "read", metadata: "read" },
      repositories: undefined,
    });
    expect(await client().getRef("main")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reuses the token across requests until 5 minutes before it expires", async () => {
    await client().getRef("main");
    await client().getRef("main");
    clock = T0 + 54 * 60 * 1000;
    await client().getRef("main");
    clock = T0 + 56 * 60 * 1000;
    await client().getRef("main");
    expect(routes().filter((r) => r.startsWith("POST /app"))).toHaveLength(2);
    expect(fake.requests.at(-1)!.headers.authorization).toBe("Bearer ghs_fake_2");
  });

  it("mints once for concurrent calls in one request", async () => {
    const github = client();
    await Promise.all([github.getRef("main"), github.getRef("main"), github.getRef("main")]);
    expect(routes().filter((r) => r.startsWith("POST /app"))).toHaveLength(1);
  });

  it("re-mints once after a 401 and retries the call", async () => {
    const github = client();
    await github.getRef("main");
    fake.revokeTokens();
    expect(await github.getRef("main")).toMatch(/^[0-9a-f]{40}$/);
    expect(routes()).toEqual([
      "POST /app/installations/:id/access_tokens",
      "GET /repos/:repo/git/ref/heads/:branch",
      "GET /repos/:repo/git/ref/heads/:branch",
      "POST /app/installations/:id/access_tokens",
      "GET /repos/:repo/git/ref/heads/:branch",
    ]);
  });

  it("fails on a second 401", async () => {
    fake.override(
      "GET",
      "/repos/:repo/git/ref/heads/:branch",
      new Response(null, { status: 401 }),
      2,
    );
    const error = await failure(() => client().getRef("main"));
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toBe("GET /repos/:repo/git/ref/heads/:branch -> 401");
  });

  it("never caches a failed mint", async () => {
    fake.override(
      "POST",
      "/app/installations/:id/access_tokens",
      new Response("{}", { status: 500 }),
    );
    expect(await failure(() => client().getRef("main"))).toMatchObject({ status: 500 });
    expect(await client().getRef("main")).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([401, 403, 404, 422])("treats a %i from the mint as misconfiguration", async (status) => {
    fake.override("POST", "/app/installations/:id/access_tokens", new Response("{}", { status }));
    expect(await failure(() => client().getRef("main"))).toMatchObject({
      code: "misconfigured",
      detail:
        "GitHub refused the App's token request: check GITHUB_APP_PRIVATE_KEY, " +
        "GITHUB_APP_CLIENT_ID and GITHUB_APP_INSTALLATION_ID, and that the App is installed " +
        "on personal-website with the permissions publishing needs.",
    });
  });

  it("treats a redirect as an error and never follows it", async () => {
    fake.override(
      "GET",
      "/repos/:repo/git/ref/heads/:branch",
      new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
    );
    const error = await failure(() => client().getRef("main"));
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 302 });
    expect(fake.requests.every((r) => new URL(r.url).origin === "https://api.github.com")).toBe(
      true,
    );
  });

  it("finds the bot identity once per isolate: token, /app, then /users", async () => {
    const identity = await client().botIdentity();
    expect(identity).toEqual({
      name: "fake-publisher[bot]",
      email: "4242+fake-publisher[bot]@users.noreply.github.com",
    });
    expect(routes()).toEqual([
      "POST /app/installations/:id/access_tokens",
      "GET /app",
      "GET /users/:login",
    ]);
    expect(fake.requests[2]!.path).toBe("/users/fake-publisher%5Bbot%5D");
    expect(await client().botIdentity()).toEqual(identity);
    expect(fake.requests).toHaveLength(3);
  });
});

/** The tree of `main`'s head. */
async function mainTree(github: ReturnType<typeof client>) {
  return (await github.getCommit((await github.getRef("main"))!)).tree;
}

describe("requests", () => {
  it.each([
    ["a branch outside blog/", (g: ReturnType<typeof client>) => g.getRef("feature/x")],
    ["a short SHA", (g: ReturnType<typeof client>) => g.getCommit("abc123")],
    ["PR number 0", (g: ReturnType<typeof client>) => g.getPull(0)],
    ["a fractional PR number", (g: ReturnType<typeof client>) => g.updatePull(1.5, {})],
    [
      "a path outside content/blog",
      (g: ReturnType<typeof client>) => g.getFile("README.md", "main"),
    ],
    [
      "a ref that is neither main nor a SHA",
      (g: ReturnType<typeof client>) => g.getFile(POST, "x"),
    ],
    ["deleting main", (g: ReturnType<typeof client>) => g.deleteRef("main")],
    [
      "a tree path outside content/blog",
      (g: ReturnType<typeof client>) =>
        g.createTree(SHA, [
          { path: ".github/workflows/x.yml", mode: "100644", type: "blob", content: "" },
        ]),
    ],
    [
      "an executable tree entry",
      (g: ReturnType<typeof client>) =>
        g.createTree(SHA, [{ path: POST, mode: "100755" as "100644", type: "blob", content: "" }]),
    ],
    [
      "a parent that isn't a SHA",
      (g: ReturnType<typeof client>) =>
        g.createCommit({
          message: "m",
          tree: SHA,
          parents: ["main"],
          author: { name: "a", email: "b" },
          committer: { name: "a", email: "b" },
        }),
    ],
  ])("refuses %s before sending anything", async (_name, call) => {
    const error = await failure(() => call(client()));
    expect((error as Error).message).toBe("invalid GitHub input");
    expect(fake.requests).toEqual([]);
  });

  it("encodes each path segment and keeps the slashes", async () => {
    const github = client();
    await github.getRef("blog/hello-world-1");
    await github.getFile(POST, "main");
    expect(fake.requests.slice(1).map((r) => r.path)).toEqual([
      "/repos/TheRizz/personal-website/git/ref/heads/blog/hello-world-1",
      "/repos/TheRizz/personal-website/contents/content/blog/2026-10-11-hello-world.md?ref=main",
    ]);
  });

  it("decodes wrapped base64 as UTF-8 and returns the blob SHA", async () => {
    const text = `---\ntitle: "Ünïcödé 漢字 😀"\n---\n\n${"Long line. ".repeat(40)}\n`;
    await fake.setMainFile(POST, text);
    const file = await client().getFile(POST, "main");
    expect(file).toMatchObject({ text, problem: null });
    expect(file!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await client().getFile("content/blog/2026-01-01-missing.md", "main")).toBeNull();
  });

  it("reports a file over 1 MB or one that isn't UTF-8 instead of its text", async () => {
    fake.largeFiles.add(POST);
    expect(await client().getFile(POST, "main")).toMatchObject({
      text: null,
      problem: "too_large",
    });
    fake.largeFiles.clear();
    fake.override(
      "GET",
      "/repos/:repo/contents/:path",
      Response.json({ type: "file", sha: SHA, encoding: "base64", content: btoa("\xff\xfe") }),
    );
    expect(await client().getFile(POST, "main")).toEqual({
      sha: SHA,
      text: null,
      problem: "binary",
    });
  });

  it("refuses to send the owner's address, however it is spelled", async () => {
    const github = client();
    const error = await failure(() =>
      github.createPull({ title: "Hi", head: "blog/x-1", body: "Write to owner&#64;example.com" }),
    );
    expect(error).toBeInstanceOf(OwnerEmailInBody);
    expect(fake.requests.filter((r) => r.route === "/repos/:repo/pulls")).toEqual([]);
  });

  it("answers ref, PR and branch outcomes as results", async () => {
    const github = client();
    const main = (await github.getRef("main"))!;
    expect(await github.getRef("blog/none-1")).toBeNull();
    const later = await fake.setMainFile(POST, "later");
    expect(await github.createRef("blog/x-1", later)).toBe("created");
    expect(await github.createRef("blog/x-1", later)).toBe("exists");
    expect(await github.updateRef("blog/x-1", main)).toBe("not_fast_forward");
    await github.deleteRef("blog/x-1");
    await github.deleteRef("blog/x-1");
    expect(await failure(() => github.getPull(7))).toMatchObject({ status: 404 });
    const pull = await fake.openPullFrom("blog/y-1", { [POST]: "changed" });
    fake.pulls.get(pull.number)!.merged = true;
    expect(await github.updatePull(pull.number, { state: "closed" })).toEqual({
      ok: false,
      status: 422,
    });
  });

  it("reads the newest deploy run and the compare status", async () => {
    const github = client();
    const main = (await github.getRef("main"))!;
    expect(await github.deployRuns(main)).toBeNull();
    fake.addDeploy(main, "completed", "failure", 1);
    fake.addDeploy(main, "in_progress", null, 2);
    expect(await github.deployRuns(main)).toEqual({
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/TheRizz/personal-website/actions/runs/2",
    });
    const later = await fake.setMainFile(POST, "later");
    expect(await github.compare(main, later)).toBe("ahead");
    expect(await github.compare(main, main)).toBe("identical");
    expect(fake.requests.at(-1)!.path).toBe(
      `/repos/TheRizz/personal-website/compare/${main}...${main}?per_page=1`,
    );
  });
});

describe("GraphQL", () => {
  it("refuses any mutation, and offers no raw request or merge", () => {
    expect(() =>
      assertQuery("mutation { mergePullRequest(input: {}) { clientMutationId } }"),
    ).toThrow();
    expect(() => assertQuery("query { viewer { login } }")).not.toThrow();
    const exported = Object.keys(githubModule);
    expect(exported.filter((name) => /graphql|request|fetch|merge/i.test(name))).toEqual([]);
    const methods = Object.keys(client());
    expect(methods.filter((name) => /merge|graphql|request|raw|force/i.test(name))).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("names the operation, and treats a lost repository as unavailable", async () => {
    expect(await client().postsTree()).toMatch(/^[0-9a-f]{40}$/);
    const graphql = fake.requests.at(-1)!;
    expect(graphql).toMatchObject({ operationName: "PostsTree" });
    expect(graphql.body).toMatchObject({
      variables: { owner: "TheRizz", name: "personal-website" },
    });
    fake.repositoryGone = true;
    expect(await failure(() => client().postsOnMain())).toMatchObject({
      code: "github_unavailable",
    });
  });

  it("fails on a GraphQL error other than NOT_FOUND", async () => {
    fake.override(
      "POST",
      "/graphql",
      Response.json({ data: null, errors: [{ type: "FORBIDDEN", message: "secret detail" }] }),
    );
    const error = await failure(() => client().postsTree());
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).toBe("POST /graphql PostsTree -> 200");
  });

  it("lists the posts on main with their text", async () => {
    const tree = await client().postsOnMain();
    expect(tree!.entries).toEqual([
      {
        name: "2026-10-11-hello-world.md",
        type: "blob",
        oid: expect.stringMatching(/^[0-9a-f]{40}$/),
        object: { byteSize: 17, isBinary: false, isTruncated: false, text: "---\ntitle: x\n---\n" },
      },
    ]);
  });

  it("pages through open PRs, at most five pages", async () => {
    fake.pageSize = 2;
    for (let n = 1; n <= 5; n++) {
      fake.otherPulls.push({ number: n, headRefName: `blog/p-${n}`, isCrossRepository: n === 5 });
    }
    const heads = await client().openPullHeads();
    expect(heads.map((h) => h.number)).toEqual([1, 2, 3, 4, 5]);
    expect(heads.at(-1)!.isCrossRepository).toBe(true);
    for (let n = 6; n <= 14; n++) {
      fake.otherPulls.push({ number: n, headRefName: `blog/p-${n}`, isCrossRepository: false });
    }
    expect(await client().openPullHeads()).toHaveLength(10);
  });

  it("finds the ci run of the newest GitHub Actions suite", async () => {
    const github = client();
    const main = (await github.getRef("main"))!;
    const pull = await fake.openPullFrom("blog/x-1", { [POST]: "changed" });
    fake.setCi(
      pull.headSha,
      { status: "COMPLETED", conclusion: "FAILURE" },
      {
        createdAt: "2026-10-13T10:00:00Z",
      },
    );
    fake.setCi(
      pull.headSha,
      { status: "IN_PROGRESS", detailsUrl: null },
      {
        createdAt: "2026-10-13T11:00:00Z",
      },
    );
    fake.setCi(
      pull.headSha,
      { status: "COMPLETED", conclusion: "SUCCESS" },
      {
        createdAt: "2026-10-13T12:00:00Z",
        appSlug: "someone-else",
      },
    );
    const status = await github.publishStatus({
      number: pull.number,
      head: pull.headSha,
      path: POST,
    });
    expect(status).toEqual({
      pullRequest: {
        state: "OPEN",
        merged: false,
        headRefName: "blog/x-1",
        headRefOid: pull.headSha,
        baseRefName: "main",
        headRepository: "TheRizz/personal-website",
        mergeCommit: null,
      },
      ci: { status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
    });
    expect(await github.publishStatus({ number: 99, head: main, path: POST })).toEqual({
      pullRequest: null,
      ci: null,
    });
  });

  it("reads the merged file at the merge commit", async () => {
    const github = client();
    const pull = await fake.openPullFrom("blog/x-1", { [POST]: "merged text" });
    const mergeSha = await fake.mergePull(pull.number);
    const status = await github.publishStatus({
      number: pull.number,
      head: pull.headSha,
      path: POST,
    });
    expect(status.pullRequest).toMatchObject({
      state: "MERGED",
      merged: true,
      mergeCommit: {
        oid: mergeSha,
        file: {
          oid: expect.stringMatching(/^[0-9a-f]{40}$/),
          text: "merged text",
          isTruncated: false,
        },
      },
    });
  });
});
