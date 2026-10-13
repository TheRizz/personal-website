import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { postFile } from "../app/lib/admin/post-file";
import { gitBlobSha } from "../app/lib/publish/git-blob";
import { PRIVATE_VALUE } from "../app/lib/publish/pr-text";
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

// Publish, republish, cancel and unpublish (contract §7) through the real router, against the D1
// fake with the shipped migrations and the recording GitHub fake. After every test, no request
// may use a route outside the allowlist, a mutation or a merge endpoint, or carry the owner's
// address, a draft id or another draft's text.

const SITE = "https://ry-mart.com";
const OWNER = "owner@example.com";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const TODAY = "2026-10-13";
const DAY = 24 * 60 * 60 * 1000;
const HELLO_PATH = "content/blog/2026-10-11-hello-world.md";
const HELLO = `---
title: "Hello, world"
date: 2026-10-11
summary: "The first post on the new site, and a quick tour of how it's built."
tags: [meta, cloudflare]
---

This is the first post on the site.

## How the site is built

The site runs on a single Cloudflare Worker.
`;
const IMAGE = "blog/11111111-2222-4333-8444-555555555555.webp";
const BODY = `Intro text.

## Why

Because it is fun.

::figure[The *lobby*]{src="${IMAGE}" alt="Two players" w="2048" h="1365"}
`;
const PRIVATE_PHRASE = "zebra-quartz-private-phrase";
const PRIVATE_IMAGE = "blog/99999999-8888-4777-8666-555555555555.webp";
const COLD = ["POST /app/installations/:id/access_tokens", "GET /app", "GET /users/:login"];
const AUTHOR = { name: "TheRizz", email: "19941577+TheRizz@users.noreply.github.com" };
const BOT = {
  name: "fake-publisher[bot]",
  email: "4242+fake-publisher[bot]@users.noreply.github.com",
};

let publicKey: CryptoKey;
let pem: string;
let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let fake: GitHubFake;
let env: Pick<Env, "DB"> & GitHubEnv;
let pending: Promise<unknown>[];
const ctx = {
  waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  passThroughOnException() {},
} as unknown as ExecutionContext;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  pem = await exportPKCS8(pair.privateKey);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetGitHubCaches();
  resetPostsCache();
  pending = [];
  ({ db, sqlite } = await createD1());
  fake = await createGitHubFake({ publicKey, files: { [HELLO_PATH]: HELLO } });
  vi.stubGlobal("fetch", fake.fetch);
  env = {
    DB: db,
    OWNER_EMAIL: OWNER,
    GIT_AUTHOR: "TheRizz <19941577+TheRizz@users.noreply.github.com>",
    GITHUB_APP_CLIENT_ID: FAKE_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: FAKE_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: pem,
  };
  // A second draft whose text and image must never reach GitHub.
  const other = insertDraft({ title: "Private", body: `${PRIVATE_PHRASE}\n` });
  addImage(other, PRIVATE_IMAGE);
});

afterEach(async () => {
  await Promise.all(pending);
  const ids = sqlite
    .prepare("SELECT id FROM drafts")
    .all()
    .map((row) => String(row.id));
  const problems = auditRequests(fake.requests, {
    ownerEmail: OWNER,
    forbidden: [...ids, PRIVATE_PHRASE, PRIVATE_IMAGE],
  });
  expect(problems).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function insertDraft(fields: { title?: string; summary?: string; body?: string; slug?: string }) {
  const id = crypto.randomUUID();
  sqlite
    .prepare(
      "INSERT INTO drafts (id, kind, slug, title, summary, category, tags, body_md, rev, " +
        "created_at, updated_at) VALUES (?, 'new', ?, ?, ?, 'notes', ?, ?, 1, 0, 0)",
    )
    .run(
      id,
      fields.slug ?? null,
      fields.title ?? "Durable Objects: a first look",
      fields.summary ?? "What I learned building the lobby.",
      JSON.stringify(["workers"]),
      fields.body ?? BODY,
    );
  return id;
}

function addImage(draftId: string, src: string, state = "ready", published = 0) {
  const [, id, ext] = /^blog\/(.+)\.(\w+)$/.exec(src)!;
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO images (id, draft_id, ext, width, height, state, published, " +
        "created_at) " +
        "VALUES (?, ?, ?, 2048, 1365, ?, ?, 0)",
    )
    .run(id, draftId, ext, state, published);
}

/** A new-post draft with its figure uploaded. */
function newDraft(fields: Parameters<typeof insertDraft>[0] = {}) {
  const id = insertDraft(fields);
  addImage(id, IMAGE);
  return id;
}

const row = (id: string) =>
  sqlite.prepare("SELECT * FROM drafts WHERE id = ?").all(id)[0] as Record<string, unknown>;

/** Saves new text into a draft, as autosave would (rev + 1). */
function save(id: string, fields: { body?: string; summary?: string; title?: string }) {
  for (const [column, value] of Object.entries({
    body_md: fields.body,
    summary: fields.summary,
    title: fields.title,
  })) {
    if (value !== undefined) {
      sqlite.prepare(`UPDATE drafts SET ${column} = ? WHERE id = ?`).run(value, id);
    }
  }
  sqlite.prepare("UPDATE drafts SET rev = rev + 1 WHERE id = ?").run(id);
}

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`${SITE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handlePublishing(request, env, ctx);
  if (!response) throw new Error(`no route for ${method} ${path}`);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined, response };
}

const publish = (id: string, extra: Record<string, unknown> = {}) =>
  call("POST", `/api/admin/drafts/${id}/publish`, {
    baseRev: Number(row(id).rev),
    date: TODAY,
    ...extra,
  });

const routeOf = (r: RecordedRequest) =>
  r.route === "/graphql" ? `POST /graphql ${r.operationName}` : `${r.method} ${r.route}`;
const sequence = () => fake.requests.map(routeOf);
const sent = (route: string) => fake.requests.filter((r) => routeOf(r) === route);
const bodyOf = (route: string) => sent(route).at(-1)?.body as Record<string, unknown>;
const clearRequests = () => fake.requests.splice(0);

async function importHello(): Promise<string> {
  const { status, json } = await call("POST", "/api/admin/posts/hello-world/import", {});
  expect(status).toBe(201);
  return json.id as string;
}

describe("publishing a new post", () => {
  it("opens one commit, branch and PR, in order, and records it", async () => {
    const id = newDraft();
    const { status, json, response } = await publish(id);
    expect(status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const slug = "durable-objects-a-first-look";
    const branch = `blog/${slug}-${NOW / 1000}`;
    expect(json).toEqual({
      stage: "opened",
      action: "publish",
      pr: 1,
      prUrl: "https://github.com/TheRizz/personal-website/pull/1",
      branch,
      runUrl: null,
      mergeSha: null,
      slug,
      mergedOtherVersion: false,
      republished: false,
    });
    expect(sequence()).toEqual([
      ...COLD,
      "GET /repos/:repo/git/ref/heads/:branch",
      "GET /repos/:repo/git/commits/:sha",
      "POST /graphql PostsTree",
      "POST /graphql PostsOnMain",
      "POST /graphql OpenPullHeads",
      "POST /repos/:repo/git/trees",
      "POST /repos/:repo/git/commits",
      "POST /repos/:repo/git/refs",
      "POST /repos/:repo/pulls",
    ]);

    const file = postFile(
      {
        title: "Durable Objects: a first look",
        summary: "What I learned building the lobby.",
        category: "notes",
        tags: ["workers"],
        bodyMd: BODY,
      },
      TODAY,
    );
    if (!file.ok) throw new Error("fixture");
    const path = `content/blog/${TODAY}-${slug}.md`;
    expect(file.path).toBe(path);
    const main = fake.refs.get("main");
    expect(bodyOf("POST /repos/:repo/git/trees")).toEqual({
      base_tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      tree: [{ path, mode: "100644", type: "blob", content: file.content }],
    });
    expect(bodyOf("POST /repos/:repo/git/commits")).toMatchObject({
      message: "Publish: Durable Objects: a first look",
      parents: [main],
      author: AUTHOR,
      committer: BOT,
    });
    expect(bodyOf("POST /repos/:repo/git/refs")).toMatchObject({ ref: `refs/heads/${branch}` });
    const pull = bodyOf("POST /repos/:repo/pulls");
    expect(pull).toMatchObject({
      title: "Publish: Durable Objects: a first look",
      head: branch,
      base: "main",
    });
    for (const part of ["## Overview", `https://ry-mart.com/blog/${slug}`, "## What changed"]) {
      expect(pull.body).toContain(part);
    }
    expect(pull.body).toContain("## Review checklist");

    const head = fake.refs.get(branch);
    expect(fake.filesAt(head!).get(path)).toBe(file.content);
    expect(row(id)).toMatchObject({
      status: "publishing",
      slug,
      source_path: path,
      pr_number: 1,
      pr_branch: branch,
      head_sha: head,
      merge_sha: null,
      pr_action: "publish",
      pr_blob_sha: await gitBlobSha(file.content),
      publish_error: null,
    });
    const revisions = sqlite
      .prepare("SELECT rev, reason, body_md FROM draft_revisions WHERE draft_id = ?")
      .all(id);
    expect(revisions).toEqual([{ rev: 1, reason: "publish", body_md: BODY }]);
  });

  it("takes the address from the request while the draft has none", async () => {
    const id = newDraft();
    const { status, json } = await publish(id, { slug: "my-address" });
    expect(status).toBe(202);
    expect(json.slug).toBe("my-address");
    expect(row(id).source_path).toBe(`content/blog/${TODAY}-my-address.md`);
  });

  it("ignores a requested address once the draft has one", async () => {
    const id = newDraft({ slug: "kept-address" });
    expect((await publish(id, { slug: "other-address" })).json.slug).toBe("kept-address");
  });

  it.each([
    [{ baseRev: 0, date: TODAY }, 400],
    [{ baseRev: 1, date: "2026-10-15" }, 400],
    [{ baseRev: 1, date: "2026-02-30" }, 400],
    [{ baseRev: 1, date: TODAY, slug: "Bad Slug" }, 400],
    [{ baseRev: 1, date: TODAY, extra: true }, 400],
    [{ baseRev: 2, date: TODAY }, 409],
  ])("refuses %j with %i and no GitHub call", async (body, status) => {
    const id = newDraft();
    const response = await call("POST", `/api/admin/drafts/${id}/publish`, body);
    expect(response.status).toBe(status);
    if (status === 409)
      expect(response.json).toMatchObject({ error: { code: "stale_draft" }, rev: 1 });
    expect(fake.requests).toEqual([]);
  });

  it("accepts the owner's local date a day either side of UTC", async () => {
    const id = newDraft();
    expect((await publish(id, { date: "2026-10-14" })).status).toBe(202);
  });

  it.each([
    ["an empty summary", { summary: "" }, /summary/i],
    [
      "a broken figure",
      { body: 'Text.\n\n::figure{src="nope" alt="x" w="1" h="1"}\n' },
      /^line 3: /,
    ],
    [
      "a stray directive",
      { body: "Text.\n\n::note trailing words\n" },
      /^line 3: .*whole ::figure/,
    ],
  ])("refuses %s as invalid_post with no GitHub call", async (_name, fields, error) => {
    const id = newDraft(fields);
    const { status, json } = await publish(id);
    expect(status).toBe(422);
    expect(json.error.code).toBe("invalid_post");
    expect(json.errors.some((e: string) => error.test(e))).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a figure whose upload isn't finished", async () => {
    const id = insertDraft({});
    addImage(id, IMAGE, "pending");
    const { status, json } = await publish(id);
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: { code: "images_not_ready" }, srcs: [IMAGE] });
    expect(fake.requests).toEqual([]);
  });

  it("refuses the owner's address as the editor stores it, with zero writes", async () => {
    const id = newDraft({ body: "Write to owner\\@example.com any time.\n" });
    const { status, json } = await publish(id);
    expect(status).toBe(422);
    expect(json.error.code).toBe("owner_email");
    expect(fake.requests).toEqual([]);
  });

  it("refuses the owner's address in the title of the PR before any write", async () => {
    const id = newDraft({ title: "Mail OWNER&#64;example.com" });
    sqlite.prepare("UPDATE drafts SET slug = 'mail-me' WHERE id = ?").run(id);
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([422, "owner_email"]);
    expect(fake.writes()).toEqual([]);
  });

  it("closes the PR and deletes the branch when D1 fails after the PR opened", async () => {
    const id = newDraft();
    env.DB = Object.assign(Object.create(db) as D1Database, {
      batch: async () => {
        throw new Error("D1_ERROR: storage is down");
      },
    });
    const { status, json } = await publish(id);
    expect(status).toBe(500);
    expect(json.error.code).toBe("internal_error");
    expect(sequence().slice(-3)).toEqual([
      "POST /repos/:repo/pulls",
      "PATCH /repos/:repo/pulls/:n",
      "DELETE /repos/:repo/git/refs/heads/:branch",
    ]);
    expect(bodyOf("PATCH /repos/:repo/pulls/:n")).toEqual({ state: "closed" });
    expect(fake.pulls.get(1)!.state).toBe("closed");
    expect([...fake.refs.keys()]).toEqual(["main"]);
    expect(row(id)).toMatchObject({ status: "draft", pr_number: null });
    expect(vi.mocked(console.error).mock.calls).toContainEqual([
      "Publishing failed:",
      "Error",
      "",
      "",
    ]);
  });

  it.each([
    ["POST", "/repos/:repo/git/trees", 500, 1],
    ["POST", "/repos/:repo/git/commits", 500, 1],
    ["POST", "/repos/:repo/git/refs", 422, 2],
  ])("answers 502 with no branch and no PR when %s %s fails", async (method, route, code, n) => {
    const id = newDraft();
    fake.override(method, route, Response.json({ message: "failed" }, { status: code }), n);
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([502, "github_error"]);
    expect([...fake.refs.keys()]).toEqual(["main"]);
    expect(fake.pulls.size).toBe(0);
    expect(sent("DELETE /repos/:repo/git/refs/heads/:branch")).toEqual([]);
    expect(row(id)).toMatchObject({ status: "draft", pr_number: null });
  });

  it("deletes the branch when the PR can't be opened", async () => {
    const id = newDraft();
    fake.override("POST", "/repos/:repo/pulls", new Response("{}", { status: 500 }));
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([502, "github_error"]);
    expect(sent("DELETE /repos/:repo/git/refs/heads/:branch")).toHaveLength(1);
    expect(sent("PATCH /repos/:repo/pulls/:n")).toEqual([]);
    expect([...fake.refs.keys()]).toEqual(["main"]);
    expect(fake.pulls.size).toBe(0);
    expect(row(id)).toMatchObject({ status: "draft", pr_number: null, slug: null });
  });

  it("answers the first failure when the clean-up fails too, and logs both", async () => {
    const id = newDraft();
    env.DB = Object.assign(Object.create(db) as D1Database, {
      batch: async () => {
        throw new Error("D1_ERROR: storage is down");
      },
    });
    fake.override(
      "DELETE",
      "/repos/:repo/git/refs/heads/:branch",
      new Response("{}", { status: 500 }),
    );
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([500, "internal_error"]);
    expect(fake.pulls.get(1)!.state).toBe("closed");
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["Publishing failed:", "GitHubError", "DELETE /repos/:repo/git/refs/heads/:branch", 500],
      ["Publishing failed:", "Error", "", ""],
    ]);
    expect(row(id)).toMatchObject({ status: "draft", pr_number: null });
  });

  it("tries the next second when the branch name is taken", async () => {
    const id = newDraft();
    await fake.openPullFrom(`blog/durable-objects-a-first-look-${NOW / 1000}`, {}, "Stale");
    fake.closePull(1);
    const { status, json } = await publish(id);
    expect(status).toBe(202);
    expect(json.branch).toBe(`blog/durable-objects-a-first-look-${NOW / 1000 + 1}`);
  });
});

describe("slug collisions", () => {
  async function refusedWith(id: string, expected: Record<string, unknown>) {
    const { status, json } = await publish(id);
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: { code: "slug_taken" }, ...expected });
    expect(fake.writes()).toEqual([]);
  }

  it("refuses a slug a file on main already has, by name or frontmatter, drafts included", async () => {
    await fake.setMainFile(
      "content/blog/2026-01-01-other.md",
      '---\ntitle: "Other"\nsummary: "S"\ndate: 2026-01-01\nslug: "taken-by-frontmatter"\n---\n\nText.\n',
    );
    await fake.setMainFile(
      "content/blog/2026-01-02-secret.md",
      '---\ntitle: "Secret"\nsummary: "S"\ndate: 2026-01-02\ndraft: true\n---\n\nText.\n',
    );
    await refusedWith(newDraft({ title: "Hello, world" }), { where: "main" });
    await refusedWith(newDraft({ title: "Taken by frontmatter" }), { where: "main" });
    await refusedWith(newDraft({ title: "Secret" }), { where: "main" });
    // The file name's slug is overridden by its frontmatter, so it is free.
    expect((await publish(newDraft({ title: "Other" }))).status).toBe(202);
  });

  it("refuses a slug an open PR's branch uses, but not a longer one or a fork's", async () => {
    const id = newDraft();
    const slug = "durable-objects-a-first-look";
    fake.otherPulls.push(
      { number: 7, headRefName: `blog/${slug}-extra-1`, isCrossRepository: false },
      { number: 8, headRefName: `blog/${slug}-1`, isCrossRepository: true },
    );
    expect((await publish(id)).status).toBe(202);

    const second = newDraft({ title: "Another post" });
    await fake.openPullFrom("blog/another-post-1700000000", {});
    clearRequests();
    await refusedWith(second, { where: "pull_request", pr: 2 });
  });

  it("refuses a slug another draft holds", async () => {
    insertDraft({ title: "Taken", slug: "durable-objects-a-first-look" });
    const id = newDraft();
    const { status, json } = await publish(id);
    expect([status, json.where]).toEqual([422, "draft"]);
    expect(fake.requests).toEqual([]);
  });

  it("closes the PR and deletes the branch when another publish wins the race", async () => {
    const id = newDraft();
    env.DB = Object.assign(Object.create(db) as D1Database, {
      batch: async (statements: D1PreparedStatement[]) => {
        sqlite.prepare("UPDATE drafts SET status = 'publishing' WHERE id = ?").run(id);
        return db.batch(statements);
      },
    });
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([409, "publishing"]);
    expect(fake.pulls.get(1)!.state).toBe("closed");
    expect([...fake.refs.keys()]).toEqual(["main"]);
  });

  it("closes the PR and answers slug_taken when the slug is taken in D1 meanwhile", async () => {
    const id = newDraft();
    env.DB = Object.assign(Object.create(db) as D1Database, {
      batch: async (statements: D1PreparedStatement[]) => {
        insertDraft({ title: "Raced", slug: "durable-objects-a-first-look" });
        return db.batch(statements);
      },
    });
    const { status, json } = await publish(id);
    expect([status, json.error.code, json.where]).toEqual([422, "slug_taken", "draft"]);
    expect(fake.pulls.get(1)!.state).toBe("closed");
    expect([...fake.refs.keys()]).toEqual(["main"]);
    expect(row(id).status).toBe("draft");
  });
});

describe("publishing a post on main", () => {
  it("opens an Update: PR that keeps date and sets updated", async () => {
    const id = await importHello();
    save(id, { body: `${String(row(id).body_md)}\n\n## More\n\nNew words here.` });
    clearRequests();
    const { status, json } = await publish(id);
    expect(status).toBe(202);
    expect(json).toMatchObject({ stage: "opened", slug: "hello-world", republished: false });
    expect(sequence()).toEqual([
      "GET /app",
      "GET /users/:login",
      "GET /repos/:repo/git/ref/heads/:branch",
      "GET /repos/:repo/git/commits/:sha",
      "GET /repos/:repo/contents/:path",
      "POST /repos/:repo/git/trees",
      "POST /repos/:repo/git/commits",
      "POST /repos/:repo/git/refs",
      "POST /repos/:repo/pulls",
    ]);
    const [entry] = bodyOf("POST /repos/:repo/git/trees").tree as {
      path: string;
      content: string;
    }[];
    expect(entry!.path).toBe(HELLO_PATH);
    expect(entry!.content).toMatch(/\ndate: 2026-10-11\nupdated: 2026-10-13\n/);
    const pull = bodyOf("POST /repos/:repo/pulls");
    expect(pull.title).toBe("Update: Hello, world");
    expect(pull.body).toContain("- Added **## More**");
    expect(pull.body).toContain("| Updated | 2026-10-13 |");
    expect(row(id)).toMatchObject({
      kind: "edit",
      slug: "hello-world",
      source_path: HELLO_PATH,
      status: "publishing",
      pr_action: "publish",
    });
  });

  it("refuses with changed_on_github when main moved, with no writes", async () => {
    const id = await importHello();
    save(id, { summary: "A new summary." });
    await fake.setMainFile(HELLO_PATH, HELLO.replace("Cloudflare Worker", "Worker"));
    const sha = await gitBlobSha(HELLO.replace("Cloudflare Worker", "Worker"));
    const moved = await publish(id);
    expect([moved.status, moved.json.error.code, moved.json.sha]).toEqual([
      409,
      "changed_on_github",
      sha,
    ]);
    await fake.setMainFile(HELLO_PATH, null);
    const gone = await publish(id);
    expect([gone.status, gone.json.error.code, gone.json.sha]).toEqual([
      409,
      "changed_on_github",
      null,
    ]);
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    ["draft", "draft: true\n"],
    ["custom_slug", 'slug: "another-address"\n'],
  ])("refuses a main version that is %s", async (problem, line) => {
    const id = await importHello();
    save(id, { summary: "A new summary." });
    const changed = HELLO.replace("tags:", `${line}tags:`);
    await fake.setMainFile(HELLO_PATH, changed);
    sqlite
      .prepare("UPDATE drafts SET base_sha = ? WHERE id = ?")
      .run(await gitBlobSha(changed), id);
    const { status, json } = await publish(id);
    expect([status, json.error.code, json.problem]).toEqual([422, "unsupported_post", problem]);
    expect(fake.writes()).toEqual([]);
  });

  it("refuses no_changes when only updated would change, even for a hand-written file", async () => {
    const id = await importHello();
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([422, "no_changes"]);
    vi.setSystemTime(NOW + 3 * 24 * 60 * 60 * 1000);
    save(id, { body: `${String(row(id).body_md)}\n` });
    const later = await publish(id, { date: "2026-10-16" });
    expect([later.status, later.json.error.code]).toEqual([422, "no_changes"]);
    expect(fake.writes()).toEqual([]);
  });

  it("publishes an edit that removes the owner's address, redacting the old value", async () => {
    const leaky = HELLO.replace(
      'summary: "The first post',
      'summary: "Mail owner@example.com. The first post',
    );
    await fake.setMainFile(HELLO_PATH, leaky);
    const id = await importHello();
    save(id, { summary: "The first post on the new site." });
    const { status } = await publish(id);
    expect(status).toBe(202);
    const body = String(bodyOf("POST /repos/:repo/pulls").body);
    expect(body).toContain(PRIVATE_VALUE);
  });
});

describe("republishing while the PR is open", () => {
  async function opened() {
    const id = newDraft();
    expect((await publish(id)).status).toBe(202);
    const first = row(id);
    save(id, { body: `${BODY}\n## Setup\n\nMore words for the setup section.\n` });
    clearRequests();
    return { id, first };
  }

  it("pushes a commit to the same branch, then refreshes the PR and comments", async () => {
    const { id, first } = await opened();
    const { status, json } = await publish(id);
    expect(status).toBe(202);
    expect(json).toMatchObject({
      stage: "opened",
      pr: 1,
      branch: first.pr_branch,
      republished: true,
    });
    expect(json.warnings).toBeUndefined();
    expect(sequence()).toEqual([
      "GET /repos/:repo/pulls/:n",
      "GET /repos/:repo/git/ref/heads/:branch",
      "GET /repos/:repo/git/commits/:sha",
      "POST /repos/:repo/git/trees",
      "POST /repos/:repo/git/commits",
      "PATCH /repos/:repo/git/refs/heads/:branch",
      "PATCH /repos/:repo/pulls/:n",
      "POST /repos/:repo/issues/:n/comments",
    ]);
    const head = fake.refs.get(String(first.pr_branch))!;
    expect(bodyOf("PATCH /repos/:repo/git/refs/heads/:branch")).toEqual({
      sha: head,
      force: false,
    });
    expect(bodyOf("POST /repos/:repo/git/commits")).toMatchObject({ parents: [first.head_sha] });
    const file = fake.filesAt(head).get(String(first.source_path))!;
    expect(file).toMatch(/\ndate: 2026-10-13\n/);
    expect(file).not.toMatch(/updated:/);
    expect(fake.pulls.get(1)!.comments).toEqual([
      expect.stringMatching(/^### What changed since the previous publish\n/),
    ]);
    expect(fake.pulls.get(1)!.comments[0]).toContain("Added **## Setup**");
    expect(row(id)).toMatchObject({ head_sha: head, pr_blob_sha: await gitBlobSha(file) });
    const revisions = sqlite
      .prepare("SELECT rev FROM draft_revisions WHERE draft_id = ? AND reason = 'publish'")
      .all(id);
    expect(revisions).toEqual([{ rev: 1 }, { rev: 2 }]);
  });

  it("keeps a new post's date and writes no updated when republished the next day", async () => {
    const { id, first } = await opened();
    vi.setSystemTime(NOW + DAY);
    expect((await publish(id, { date: "2026-10-14" })).status).toBe(202);
    const head = fake.refs.get(String(first.pr_branch))!;
    const file = fake.filesAt(head).get(String(first.source_path))!;
    expect(file).toMatch(/\ndate: 2026-10-13\n/);
    expect(file).not.toMatch(/updated:/);
  });

  it("republishes an Update: PR the next day with the post's date and a new updated", async () => {
    const id = await importHello();
    save(id, { summary: "A new summary." });
    expect((await publish(id)).status).toBe(202);
    save(id, { summary: "Another summary." });
    vi.setSystemTime(NOW + DAY);
    clearRequests();
    const { status, json } = await publish(id, { date: "2026-10-14" });
    expect([status, json.republished]).toEqual([202, true]);
    const [entry] = bodyOf("POST /repos/:repo/git/trees").tree as {
      path: string;
      content: string;
    }[];
    expect(entry!.path).toBe(HELLO_PATH);
    expect(entry!.content).toMatch(/\ndate: 2026-10-11\nupdated: 2026-10-14\n/);
    expect(bodyOf("PATCH /repos/:repo/pulls/:n").title).toBe("Update: Hello, world");
    expect(fake.pulls.get(1)!.comments).toHaveLength(1);
  });

  it("republishes again before GitHub shows the last push as the PR's head", async () => {
    const { id, first } = await opened();
    expect((await publish(id)).status).toBe(202);
    const branch = String(first.pr_branch);
    const second = fake.refs.get(branch)!;
    // GitHub hasn't moved the PR's head yet: the next read of the PR still shows the first.
    expect(fake.pulls.get(1)!.headSha).toBe(first.head_sha);
    save(id, { body: `${BODY}\n## Setup\n\nFewer words for the setup.\n` });
    clearRequests();
    const { status, json } = await publish(id);
    expect([status, json.republished]).toEqual([202, true]);
    expect(bodyOf("POST /repos/:repo/git/commits")).toMatchObject({ parents: [second] });
    expect(row(id).head_sha).toBe(fake.refs.get(branch));
    expect(fake.pulls.get(1)!.comments).toHaveLength(2);
  });

  it("goes on to the PR when D1 recorded the head but answered an error", async () => {
    const { id, first } = await opened();
    save(id, { title: "Durable Objects: a second look" });
    let failed = false;
    env.DB = Object.assign(Object.create(db) as D1Database, {
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await db.batch(statements);
        if (failed) return results;
        failed = true;
        throw new Error("D1_ERROR: Network connection lost.");
      },
    });
    const { status, json } = await publish(id);
    expect([status, json.republished, json.warnings]).toEqual([202, true, undefined]);
    expect(row(id).head_sha).toBe(fake.refs.get(String(first.pr_branch)));
    expect(fake.pulls.get(1)!.title).toBe("Publish: Durable Objects: a second look");
    expect(fake.pulls.get(1)!.comments).toHaveLength(1);
    const revisions = sqlite
      .prepare("SELECT rev FROM draft_revisions WHERE draft_id = ? AND reason = 'publish'")
      .all(id);
    expect(revisions).toEqual([{ rev: 1 }, { rev: 3 }]);
  });

  it("records the new head before refreshing the PR, and warns when the refresh fails", async () => {
    const { id, first } = await opened();
    let headDuringRefresh: unknown;
    fake.override("PATCH", "/repos/:repo/pulls/:n", () => {
      headDuringRefresh = row(id).head_sha;
      return new Response("{}", { status: 500 });
    });
    const { status, json } = await publish(id);
    expect([status, json.warnings]).toEqual([202, ["pr_not_updated"]]);
    const head = fake.refs.get(String(first.pr_branch));
    expect(headDuringRefresh).toBe(head);
    expect(row(id).head_sha).toBe(head);
  });

  it("refuses when the branch moved or went on GitHub", async () => {
    const { id, first } = await opened();
    const branch = String(first.pr_branch);
    const moved = await fake.openPullFrom("blog/elsewhere-1", { "content/blog/x.md": "x" });
    fake.refs.set(branch, moved.headSha);
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([409, "branch_changed"]);
    fake.refs.delete(branch);
    expect((await publish(id)).json.error.code).toBe("pr_not_open");
    fake.refs.set(branch, String(first.head_sha));
    fake.override(
      "PATCH",
      "/repos/:repo/git/refs/heads/:branch",
      Response.json({ message: "Update is not a fast forward" }, { status: 422 }),
    );
    const again = await publish(id);
    expect([again.status, again.json.error.code]).toEqual([409, "branch_changed"]);
    expect(row(id).head_sha).toBe(first.head_sha);
  });

  it("refuses a PR that isn't open, or isn't ours", async () => {
    const { id } = await opened();
    const pull = fake.pulls.get(1)!;
    pull.headRepo = "someone/fork";
    expect((await publish(id)).json.error.code).toBe("pr_mismatch");
    pull.headRepo = "TheRizz/personal-website";
    fake.closePull(1);
    expect((await publish(id)).json.error.code).toBe("pr_not_open");
    expect(fake.writes()).toEqual([]);
  });

  it("refuses no_changes when nothing changed since the last publish", async () => {
    const id = newDraft();
    await publish(id);
    save(id, { body: `${BODY}\n\n` });
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([422, "no_changes"]);
  });

  it("refuses an edit's republish when main moved meanwhile", async () => {
    const id = await importHello();
    save(id, { summary: "A new summary." });
    expect((await publish(id)).status).toBe(202);
    save(id, { summary: "Another summary." });
    await fake.setMainFile(HELLO_PATH, `${HELLO}\nMore.\n`);
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([409, "changed_on_github_open_pr"]);
    expect(json.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to publish while an unpublish PR is open", async () => {
    const unpublished = await call("POST", "/api/admin/posts/hello-world/unpublish", {});
    const id = unpublished.json.draftId as string;
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([409, "unpublishing"]);
  });
});

describe("cancel", () => {
  async function opened() {
    const id = newDraft();
    await publish(id);
    clearRequests();
    return id;
  }
  const cancel = (id: string) => call("POST", `/api/admin/drafts/${id}/cancel`, {});

  it("closes the PR, deletes the branch and makes the draft a draft again", async () => {
    const id = await opened();
    const branch = String(row(id).pr_branch);
    const { status, json } = await cancel(id);
    expect(status).toBe(200);
    expect(json).toMatchObject({ stage: "draft", pr: null, slug: null });
    expect(sequence()).toEqual([
      "GET /repos/:repo/pulls/:n",
      "PATCH /repos/:repo/pulls/:n",
      "DELETE /repos/:repo/git/refs/heads/:branch",
    ]);
    expect(fake.pulls.get(1)!.state).toBe("closed");
    expect(fake.refs.has(branch)).toBe(false);
    expect(row(id)).toMatchObject({
      status: "draft",
      pr_number: null,
      pr_branch: null,
      head_sha: null,
      pr_action: null,
      slug: null,
      source_path: null,
    });
  });

  it("refuses a merged PR without writing anything", async () => {
    const id = await opened();
    await fake.mergePull(1);
    const { status, json } = await cancel(id);
    expect([status, json.error.code]).toEqual([409, "already_merged"]);
    expect(row(id).status).toBe("publishing");
    expect(fake.writes()).toEqual([]);
  });

  it("looks again when GitHub won't close it, and refuses if it was merged", async () => {
    const id = await opened();
    fake.override("PATCH", "/repos/:repo/pulls/:n", async () => {
      await fake.mergePull(1);
      return Response.json({ message: "merged" }, { status: 422 });
    });
    const { status, json } = await cancel(id);
    expect([status, json.error.code]).toEqual([409, "already_merged"]);
    expect(sequence()).toEqual([
      "GET /repos/:repo/pulls/:n",
      "PATCH /repos/:repo/pulls/:n",
      "GET /repos/:repo/pulls/:n",
    ]);
    expect(row(id).status).toBe("publishing");
  });

  it("refuses a PR whose head isn't our branch", async () => {
    const id = await opened();
    fake.pulls.get(1)!.head = "blog/someone-else-1";
    const { status, json } = await cancel(id);
    expect([status, json.error.code]).toEqual([409, "pr_mismatch"]);
    expect(fake.writes()).toEqual([]);
  });

  it("refuses with no GitHub call once the merge is recorded, or with no PR", async () => {
    const id = await opened();
    sqlite.prepare("UPDATE drafts SET merge_sha = ? WHERE id = ?").run("b".repeat(40), id);
    expect((await cancel(id)).json.error.code).toBe("already_merged");
    expect((await cancel(newDraft({ title: "Other" }))).json.error.code).toBe("not_publishing");
    expect((await call("POST", `/api/admin/drafts/${id}/cancel`, { x: 1 })).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it("keeps the slug of a post that went live before", async () => {
    const id = await importHello();
    save(id, { summary: "A new summary." });
    await publish(id);
    const { json } = await cancel(id);
    expect(json.slug).toBe("hello-world");
    expect(row(id)).toMatchObject({ kind: "edit", slug: "hello-world", source_path: HELLO_PATH });
  });
});

describe("unpublish", () => {
  const unpublish = (slug: string) => call("POST", `/api/admin/posts/${slug}/unpublish`, {});

  it("opens a PR deleting the file through a sha: null entry, on a tracking draft", async () => {
    const { status, json } = await unpublish("hello-world");
    expect(status).toBe(202);
    expect(json).toMatchObject({
      stage: "opened",
      action: "unpublish",
      pr: 1,
      slug: "hello-world",
      draftId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(sequence()).toEqual([
      ...COLD,
      "POST /graphql PostsTree",
      "POST /graphql PostsOnMain",
      "GET /repos/:repo/git/ref/heads/:branch",
      "GET /repos/:repo/git/commits/:sha",
      "GET /repos/:repo/contents/:path",
      "POST /repos/:repo/git/trees",
      "POST /repos/:repo/git/commits",
      "POST /repos/:repo/git/refs",
      "POST /repos/:repo/pulls",
    ]);
    expect(bodyOf("POST /repos/:repo/git/trees").tree).toEqual([
      { path: HELLO_PATH, mode: "100644", type: "blob", sha: null },
    ]);
    const pull = bodyOf("POST /repos/:repo/pulls");
    expect(pull.title).toBe("Unpublish: Hello, world");
    expect(pull.body).toContain(`Deletes \`${HELLO_PATH}\`.`);
    expect(pull.body).not.toContain("How the site is built");
    expect(fake.filesAt(fake.pulls.get(1)!.headSha).has(HELLO_PATH)).toBe(false);
    expect(row(json.draftId)).toMatchObject({
      kind: "edit",
      slug: "hello-world",
      source_path: HELLO_PATH,
      status: "publishing",
      pr_action: "unpublish",
      pr_blob_sha: null,
      title: "Hello, world",
    });
  });

  it("titles the PR with the path when the title holds the owner's address", async () => {
    await fake.setMainFile(HELLO_PATH, HELLO.replace('"Hello, world"', '"Mail owner@example.com"'));
    const { status } = await unpublish("hello-world");
    expect(status).toBe(202);
    expect(bodyOf("POST /repos/:repo/pulls").title).toBe(`Unpublish: ${HELLO_PATH}`);
  });

  it("unpublishes a post the editor can't edit, and refuses while a PR is open", async () => {
    await fake.setMainFile(HELLO_PATH, HELLO.replace("tags:", 'slug: "hello"\ntags:'));
    const first = await unpublish("hello");
    expect(first.status).toBe(202);
    expect(row(first.json.draftId)).toMatchObject({ slug: "hello", kind: "edit" });
    const again = await unpublish("hello");
    expect([again.status, again.json.error.code]).toEqual([409, "publishing"]);
  });

  it("uses the post's existing edit draft", async () => {
    const id = await importHello();
    expect((await unpublish("hello-world")).json.draftId).toBe(id);
  });

  it("refuses a file outside the post path pattern, an unknown slug and a new post's slug", async () => {
    await fake.setMainFile(
      "content/blog/notes.md",
      '---\ntitle: "Notes"\nsummary: "S"\ndate: 2026-01-01\n---\n\nText.\n',
    );
    const bad = await unpublish("notes");
    expect([bad.status, bad.json.error.code, bad.json.problem]).toEqual([
      422,
      "unsupported_post",
      "bad_path",
    ]);
    expect((await unpublish("no-such-post")).status).toBe(404);
    const holder = insertDraft({ title: "Mine", slug: "hello-world" });
    const taken = await unpublish("hello-world");
    expect([taken.status, taken.json.error.code, taken.json.draftId]).toEqual([
      409,
      "slug_in_use",
      holder,
    ]);
    expect(fake.writes()).toEqual([]);
  });

  it("closes the PR and deletes the branch when D1 fails after the PR opened", async () => {
    const id = await importHello();
    env.DB = Object.assign(Object.create(db) as D1Database, {
      batch: async () => {
        throw new Error("D1_ERROR: storage is down");
      },
    });
    const { status, json } = await unpublish("hello-world");
    expect([status, json.error.code]).toEqual([500, "internal_error"]);
    expect(fake.pulls.get(1)!.state).toBe("closed");
    expect([...fake.refs.keys()]).toEqual(["main"]);
    expect(row(id)).toMatchObject({ status: "draft", pr_number: null, pr_action: null });
  });

  it("refuses when the file is gone at the commit it would branch from", async () => {
    // Listed (from the probe's cache), then gone when read at main's head.
    await call("GET", "/api/admin/posts");
    fake.override("GET", "/repos/:repo/contents/:path", Response.json({}, { status: 404 }));
    const { status, json } = await unpublish("hello-world");
    expect([status, json.error.code, json.sha]).toEqual([409, "changed_on_github", null]);
    expect(fake.writes()).toEqual([]);
  });
});

describe("routing", () => {
  it("leaves other paths alone and checks ids, slugs and methods", async () => {
    const other = new Request(`${SITE}/api/admin/drafts`);
    expect(await handlePublishing(other, env, ctx)).toBeNull();
    expect((await call("POST", "/api/admin/drafts/not-an-id/publish", {})).status).toBe(404);
    expect((await call("POST", "/api/admin/posts/Not_A_Slug/import", {})).status).toBe(404);
    expect((await call("GET", `/api/admin/drafts/${crypto.randomUUID()}/publish`)).status).toBe(
      405,
    );
    expect((await call("POST", `/api/admin/drafts/${crypto.randomUUID()}/status`, {})).status).toBe(
      405,
    );
    expect((await call("POST", "/api/admin/posts", {})).status).toBe(405);
    expect(
      (
        await call("POST", `/api/admin/drafts/${crypto.randomUUID()}/publish`, {
          baseRev: 1,
          date: TODAY,
        })
      ).status,
    ).toBe(404);
    expect(fake.requests).toEqual([]);
  });

  it("answers 503 when publishing isn't configured, with no GitHub call", async () => {
    const id = newDraft();
    env.GITHUB_APP_PRIVATE_KEY = undefined;
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([503, "misconfigured"]);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ["an encrypted key", () => pem.replace(/PRIVATE KEY-----/g, "ENCRYPTED PRIVATE KEY-----")],
    ["text that isn't a key", () => "not a key"],
  ])("answers 503 for %s, logging only the setting's name", async (_name, key) => {
    const id = newDraft();
    env.GITHUB_APP_PRIVATE_KEY = key();
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([503, "misconfigured"]);
    expect(fake.requests).toEqual([]);
    const calls = vi.mocked(console.error).mock.calls;
    expect(calls).toContainEqual(["Publishing is misconfigured:", "GITHUB_APP_PRIVATE_KEY"]);
    const logged = calls.flat().join(" ");
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain(pem.split("\n")[1]);
  });

  it("answers 502 for a GitHub failure and logs only its kind", async () => {
    const id = newDraft();
    fake.override("GET", "/repos/:repo/git/commits/:sha", new Response("{}", { status: 500 }));
    const { status, json } = await publish(id);
    expect([status, json.error.code]).toEqual([502, "github_error"]);
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["Publishing failed:", "GitHubError", "GET /repos/:repo/git/commits/:sha", 500],
    ]);
  });
});
