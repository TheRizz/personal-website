import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobSha } from "../app/lib/publish/git-blob";
import { createD1 } from "./d1-fake";
import { resetGitHubCaches, type GitHubEnv } from "./github";
import {
  FAKE_CLIENT_ID,
  FAKE_INSTALLATION_ID,
  auditRequests,
  createGitHubFake,
  type GitHubFake,
  type RecordedRequest,
} from "./github-fake";
import { resetPostsCache } from "./posts";
import { handlePublishing } from "./publish";

// The posts on `main`, import and refresh (contract §9) through the real router, against the D1
// fake and the recording GitHub fake.

const SITE = "https://ry-mart.com";
const OWNER = "owner@example.com";
const HELLO_PATH = "content/blog/2026-10-11-hello-world.md";
const post = (fields: string, body = "Some text.") => `---\n${fields}\n---\n\n${body}\n`;
const HELLO = post(
  'title: "Hello, world"\ndate: 2026-10-11\nsummary: "The first post."\ntags: [meta, Cloudflare]',
  "\nThis is the first post.\n\n## How\n\nWith a Worker.",
);
const FILES: Record<string, string> = {
  [HELLO_PATH]: HELLO,
  "content/blog/2026-10-12-unfinished.md": post(
    'title: "Unfinished"\nsummary: "S"\ndate: 2026-10-12\ndraft: true',
  ),
  "content/blog/2026-10-10-custom.md": post(
    'title: "Custom"\nsummary: "S"\ndate: 2026-10-10\nslug: "my-custom"',
  ),
  "content/blog/2026-10-09-broken.md": post('title: "Broken\nsummary: [unclosed'),
  "content/blog/notes.md": post('title: "Notes"\nsummary: "S"\ndate: 2026-01-01'),
  "content/blog/2026-10-08-big.md": post('title: "Big"\nsummary: "S"\ndate: 2026-10-08'),
  "content/blog/2026-10-07-picture.md": post('title: "Pic"\nsummary: "S"\ndate: 2026-10-07'),
  "content/blog/README.txt": "Not a post.\n",
};

let publicKey: CryptoKey;
let pem: string;
let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let fake: GitHubFake;
let env: Pick<Env, "DB"> & GitHubEnv;
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  pem = await exportPKCS8(pair.privateKey);
});

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetGitHubCaches();
  resetPostsCache();
  ({ db, sqlite } = await createD1());
  fake = await createGitHubFake({ publicKey, files: FILES });
  fake.largeFiles.add("content/blog/2026-10-08-big.md");
  fake.binaryFiles.add("content/blog/2026-10-07-picture.md");
  vi.stubGlobal("fetch", fake.fetch);
  env = {
    DB: db,
    OWNER_EMAIL: OWNER,
    GIT_AUTHOR: "TheRizz <19941577+TheRizz@users.noreply.github.com>",
    GITHUB_APP_CLIENT_ID: FAKE_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: FAKE_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: pem,
  };
});

afterEach(() => {
  const ids = sqlite
    .prepare("SELECT id FROM drafts")
    .all()
    .map((row) => String(row.id));
  expect(auditRequests(fake.requests, { ownerEmail: OWNER, forbidden: ids })).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`${SITE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handlePublishing(request, env, ctx);
  if (!response) throw new Error(`no route for ${method} ${path}`);
  return { status: response.status, json: JSON.parse(await response.text()), response };
}

const list = () => call("GET", "/api/admin/posts");
const importPost = (slug: string, body: unknown = {}) =>
  call("POST", `/api/admin/posts/${slug}/import`, body);
const row = (id: string) =>
  sqlite.prepare("SELECT * FROM drafts WHERE id = ?").all(id)[0] as Record<string, unknown>;
const routeOf = (r: RecordedRequest) =>
  r.route === "/graphql" ? `POST /graphql ${r.operationName}` : `${r.method} ${r.route}`;

describe("the posts on main", () => {
  it("lists every Markdown file with its effective slug and what keeps the editor off it", async () => {
    const { status, json, response } = await list();
    expect(status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json.treeSha).toMatch(/^[0-9a-f]{40}$/);
    const summary = json.posts.map((p: Record<string, unknown>) => [
      p.path,
      p.slug,
      p.date,
      p.problem,
      p.editable,
    ]);
    expect(summary).toEqual([
      ["content/blog/2026-10-12-unfinished.md", "unfinished", "2026-10-12", "draft", false],
      [HELLO_PATH, "hello-world", "2026-10-11", null, true],
      ["content/blog/2026-10-10-custom.md", "my-custom", "2026-10-10", "custom_slug", false],
      ["content/blog/notes.md", "notes", "2026-01-01", "bad_path", false],
      ["content/blog/2026-10-07-picture.md", "picture", null, "binary", false],
      ["content/blog/2026-10-08-big.md", "big", null, "too_large", false],
      ["content/blog/2026-10-09-broken.md", "broken", null, "invalid", false],
    ]);
    expect(json.posts[1]).toEqual({
      slug: "hello-world",
      path: HELLO_PATH,
      sha: await gitBlobSha(HELLO),
      title: "Hello, world",
      date: "2026-10-11",
      updated: null,
      url: "https://ry-mart.com/blog/hello-world",
      editable: true,
      problem: null,
      draft: null,
    });
  });

  it("answers from the isolate's cache while the tree is the same", async () => {
    await list();
    fake.requests.splice(0);
    await list();
    expect(fake.requests.map(routeOf)).toEqual(["POST /graphql PostsTree"]);
    await fake.setMainFile(
      "content/blog/2026-10-13-new.md",
      post('title: "New"\nsummary: "S"\ndate: 2026-10-13'),
    );
    fake.requests.splice(0);
    const { json } = await list();
    expect(fake.requests.map(routeOf)).toEqual([
      "POST /graphql PostsTree",
      "POST /graphql PostsOnMain",
    ]);
    expect(json.posts[0].slug).toBe("new");
  });

  it("attaches the draft with the post's path, else the one with its slug", async () => {
    const { json: imported } = await importPost("hello-world");
    const holder = crypto.randomUUID();
    sqlite
      .prepare(
        "INSERT INTO drafts (id, kind, slug, status, pr_number, pr_action, created_at, " +
          "updated_at) VALUES (?, 'new', 'my-custom', 'publishing', 4, 'publish', 0, 0)",
      )
      .run(holder);
    const { json } = await list();
    const bySlug = Object.fromEntries(json.posts.map((p: { slug: string }) => [p.slug, p]));
    expect(bySlug["hello-world"].draft).toEqual({
      id: imported.id,
      status: "draft",
      prNumber: null,
      prAction: null,
    });
    expect(bySlug["my-custom"].draft).toEqual({
      id: holder,
      status: "publishing",
      prNumber: 4,
      prAction: "publish",
    });
    expect(bySlug.notes.draft).toBeNull();
  });
});

describe("import", () => {
  it("creates the post's edit draft once, then reopens it with no GitHub call", async () => {
    const created = await importPost("hello-world");
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), created: true });
    expect(row(created.json.id)).toMatchObject({
      kind: "edit",
      source_path: HELLO_PATH,
      base_sha: await gitBlobSha(HELLO),
      post_date: "2026-10-11",
      slug: "hello-world",
      title: "Hello, world",
      summary: "The first post.",
      category: null,
      tags: '["meta","cloudflare"]',
      cover_key: null,
      body_md: "This is the first post.\n\n## How\n\nWith a Worker.",
      rev: 1,
      status: "draft",
    });
    fake.requests.splice(0);
    const again = await importPost("hello-world");
    expect([again.status, again.json]).toEqual([200, { id: created.json.id, created: false }]);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ["unfinished", "draft"],
    ["my-custom", "custom_slug"],
    ["broken", "invalid"],
    ["big", "too_large"],
    ["picture", "binary"],
    ["notes", "bad_path"],
  ])("refuses %s as unsupported (%s)", async (slug, problem) => {
    const { status, json } = await importPost(slug);
    expect([status, json.error.code, json.problem]).toEqual([422, "unsupported_post", problem]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM drafts").all()).toEqual([{ n: 0 }]);
  });

  it("refuses an unknown post, and a slug a new post's draft holds", async () => {
    expect((await importPost("no-such-post")).status).toBe(404);
    const holder = crypto.randomUUID();
    sqlite
      .prepare(
        "INSERT INTO drafts (id, kind, slug, created_at, updated_at) " +
          "VALUES (?, 'new', 'hello-world', 0, 0)",
      )
      .run(holder);
    const { status, json } = await importPost("hello-world");
    expect([status, json.error.code, json.draftId]).toEqual([409, "slug_in_use", holder]);
  });

  it.each([
    { refresh: false, baseRev: 1 },
    { refresh: true },
    { refresh: true, baseRev: 0 },
    { x: 1 },
  ])("refuses the body %j", async (body) => {
    expect((await importPost("hello-world", body)).status).toBe(400);
  });
});

describe("refresh", () => {
  async function imported() {
    const { json } = await importPost("hello-world");
    sqlite
      .prepare("UPDATE drafts SET body_md = 'My local edit.', rev = 2 WHERE id = ?")
      .run(json.id);
    return json.id as string;
  }
  const refresh = (baseRev: number) => importPost("hello-world", { refresh: true, baseRev });

  it("loads the GitHub version and keeps the replaced one as a conflict revision", async () => {
    const id = await imported();
    const changed = HELLO.replace("With a Worker.", "With one Worker.");
    await fake.setMainFile(HELLO_PATH, changed);
    const { status, json } = await refresh(2);
    expect([status, json]).toEqual([200, { id, created: false, rev: 3 }]);
    expect(row(id)).toMatchObject({
      body_md: "This is the first post.\n\n## How\n\nWith one Worker.",
      base_sha: await gitBlobSha(changed),
      source_path: HELLO_PATH,
      rev: 3,
    });
    expect(
      sqlite.prepare("SELECT rev, reason, body_md FROM draft_revisions WHERE draft_id = ?").all(id),
    ).toEqual([{ rev: 2, reason: "conflict", body_md: "My local edit." }]);
  });

  it("refuses a stale rev with the current one", async () => {
    const id = await imported();
    const { status, json } = await refresh(1);
    expect([status, json.error.code, json.rev]).toEqual([409, "stale_draft", 2]);
    expect(row(id).body_md).toBe("My local edit.");
  });

  it("finds a renamed file by its slug", async () => {
    const id = await imported();
    await fake.setMainFile(HELLO_PATH, null);
    const moved = "content/blog/2026-10-12-hello-world.md";
    await fake.setMainFile(moved, HELLO);
    expect((await refresh(2)).status).toBe(200);
    expect(row(id).source_path).toBe(moved);
  });

  it("turns the draft into a new post when the file is gone", async () => {
    const id = await imported();
    await fake.setMainFile(HELLO_PATH, null);
    const { status, json } = await refresh(2);
    expect([status, json]).toEqual([200, { id, created: false, converted: true, rev: 2 }]);
    expect(row(id)).toMatchObject({
      kind: "new",
      source_path: null,
      base_sha: null,
      post_date: null,
      slug: "hello-world",
      body_md: "My local edit.",
    });
  });

  it("doesn't take a refresh of a live post for a merge of another version", async () => {
    const id = await imported();
    // Live, as the last publish left it: the merged file is the one it pushed.
    sqlite
      .prepare(
        "UPDATE drafts SET status = 'published', pr_number = 1, merge_sha = ?, " +
          "pr_action = 'publish', pr_blob_sha = base_sha WHERE id = ?",
      )
      .run("a".repeat(40), id);
    const status = async () => (await call("GET", `/api/admin/drafts/${id}/status`)).json;
    expect(await status()).toMatchObject({ stage: "live", mergedOtherVersion: false });
    await fake.setMainFile(HELLO_PATH, HELLO.replace("With a Worker.", "With one Worker."));
    expect((await refresh(2)).status).toBe(200);
    expect(row(id).pr_blob_sha).toBeNull();
    expect(await status()).toMatchObject({ stage: "live", mergedOtherVersion: false });

    sqlite.prepare("UPDATE drafts SET pr_blob_sha = ? WHERE id = ?").run("b".repeat(40), id);
    await fake.setMainFile(HELLO_PATH, null);
    expect((await refresh(3)).json.converted).toBe(true);
    expect(row(id).pr_blob_sha).toBeNull();
    expect(await status()).toMatchObject({ stage: "live", mergedOtherVersion: false });
  });

  it("refuses a file marked draft, an open PR and a draft that doesn't exist", async () => {
    const id = await imported();
    await fake.setMainFile(HELLO_PATH, HELLO.replace("tags:", "draft: true\ntags:"));
    const draft = await refresh(2);
    expect([draft.status, draft.json.problem]).toEqual([422, "draft"]);
    sqlite.prepare("UPDATE drafts SET status = 'publishing', pr_number = 1 WHERE id = ?").run(id);
    expect((await refresh(2)).json.error.code).toBe("publishing");
    expect((await importPost("no-such-post", { refresh: true, baseRev: 1 })).status).toBe(404);
  });
});
