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
import { deriveDeployStage, derivePrStage } from "./publish-status";

// The status of a draft's pull request (contract §8): the pure stage derivation, table by table,
// then each D1 transition through the real router, with PRs opened by the real publish flow and
// merged, closed and checked on the recording GitHub fake.

const SITE = "https://ry-mart.com";
const OWNER = "owner@example.com";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const TODAY = "2026-10-13";
const HELLO_PATH = "content/blog/2026-10-11-hello-world.md";
const HELLO = `---
title: "Hello, world"
date: 2026-10-11
summary: "The first post on the new site."
tags: [meta]
---

This is the first post on the site.
`;
const SLUG = "durable-objects-a-first-look";
const PATH = `content/blog/${TODAY}-${SLUG}.md`;
const img = (n: number) => `blog/${String(n).repeat(8)}-2222-4333-8444-555555555555.webp`;
const figure = (src: string) => `::figure{src="${src}" alt="A picture" w="2048" h="1365"}`;
const RUN = "https://github.com/TheRizz/personal-website/actions/runs/7";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

let publicKey: CryptoKey;
let pem: string;
let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let fake: GitHubFake;
let env: Pick<Env, "DB"> & GitHubEnv;
let pending: Promise<unknown>[];
let statements: string[];
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
  statements = [];
  ({ db, sqlite } = await createD1());
  fake = await createGitHubFake({ publicKey, files: { [HELLO_PATH]: HELLO } });
  vi.stubGlobal("fetch", fake.fetch);
  // Every statement the Worker prepares is recorded, to prove a poll wrote nothing.
  const recording = Object.assign(Object.create(db) as D1Database, {
    prepare: (sql: string) => {
      statements.push(sql);
      return db.prepare(sql);
    },
  });
  env = {
    DB: recording,
    OWNER_EMAIL: OWNER,
    GIT_AUTHOR: "TheRizz <19941577+TheRizz@users.noreply.github.com>",
    GITHUB_APP_CLIENT_ID: FAKE_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: FAKE_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: pem,
  };
});

afterEach(async () => {
  await Promise.all(pending);
  const ids = sqlite
    .prepare("SELECT id FROM drafts")
    .all()
    .map((row) => String(row.id));
  expect(auditRequests(fake.requests, { ownerEmail: OWNER, forbidden: ids })).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function addImage(draftId: string | null, src: string, state = "ready", published = 0) {
  const [, id, ext] = /^blog\/(.+)\.(\w+)$/.exec(src)!;
  sqlite
    .prepare(
      "INSERT INTO images (id, draft_id, ext, width, height, state, published, created_at) " +
        "VALUES (?, ?, ?, 2048, 1365, ?, ?, 0)",
    )
    .run(id, draftId, ext, state, published);
}

const imageRow = (src: string) =>
  sqlite.prepare("SELECT state, published FROM images WHERE id = ?").all(src.slice(5, 41))[0];

const row = (id: string) =>
  sqlite.prepare("SELECT * FROM drafts WHERE id = ?").all(id)[0] as Record<string, unknown>;

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`${SITE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handlePublishing(request, env, ctx);
  if (!response) throw new Error(`no route for ${method} ${path}`);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

/** A new post's draft with a PR open for it (PR #1 unless one was opened before). */
async function opened(body = "Some words.\n", images: string[] = []) {
  const id = crypto.randomUUID();
  sqlite
    .prepare(
      "INSERT INTO drafts (id, kind, title, summary, tags, body_md, rev, created_at, updated_at) " +
        "VALUES (?, 'new', 'Durable Objects: a first look', 'Summary.', '[]', ?, 1, 0, 0)",
    )
    .run(id, body);
  for (const src of images) addImage(id, src);
  const published = await call("POST", `/api/admin/drafts/${id}/publish`, {
    baseRev: 1,
    date: TODAY,
  });
  expect(published.status).toBe(202);
  return { id, pr: published.json.pr as number, head: String(row(id).head_sha) };
}

const status = (id: string) => call("GET", `/api/admin/drafts/${id}/status`);
const writes = () => statements.filter((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql));
const routeOf = (r: RecordedRequest) =>
  r.route === "/graphql" ? `POST /graphql ${r.operationName}` : `${r.method} ${r.route}`;
/** Forgets what the setup sent and wrote. */
function startPolling() {
  fake.requests.splice(0);
  statements.splice(0);
}

describe("derivePrStage", () => {
  const ci = (
    status: string,
    conclusion: string | null = null,
    detailsUrl: string | null = RUN,
  ) => ({
    status,
    conclusion,
    detailsUrl,
  });
  it.each([
    ["no pull request", null, null, { stage: "closed", runUrl: null, write: true }],
    [
      "closed",
      { state: "CLOSED", headRefOid: SHA },
      null,
      { stage: "closed", runUrl: null, write: true },
    ],
    [
      "merged",
      { state: "MERGED", headRefOid: SHA },
      null,
      { stage: "merged", runUrl: null, write: true },
    ],
    [
      "open on another head",
      { state: "OPEN", headRefOid: OTHER_SHA },
      ci("COMPLETED", "FAILURE"),
      { stage: "opened", runUrl: null, write: false },
    ],
    [
      "open with no ci run",
      { state: "OPEN", headRefOid: SHA },
      null,
      { stage: "opened", runUrl: null, write: true },
    ],
    [
      "ci queued",
      { state: "OPEN", headRefOid: SHA },
      ci("QUEUED"),
      { stage: "ci_running", runUrl: null, write: true },
    ],
    [
      "ci running",
      { state: "OPEN", headRefOid: SHA },
      ci("IN_PROGRESS"),
      { stage: "ci_running", runUrl: null, write: true },
    ],
    ...["SUCCESS", "NEUTRAL", "SKIPPED"].map(
      (conclusion) =>
        [
          `ci ${conclusion}`,
          { state: "OPEN", headRefOid: SHA },
          ci("COMPLETED", conclusion),
          { stage: "review", runUrl: null, write: true },
        ] as const,
    ),
    ...["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].map(
      (conclusion) =>
        [
          `ci ${conclusion}`,
          { state: "OPEN", headRefOid: SHA },
          ci("COMPLETED", conclusion),
          { stage: "ci_failed", runUrl: RUN, write: true },
        ] as const,
    ),
    [
      "ci failed with a link off GitHub",
      { state: "OPEN", headRefOid: SHA },
      ci("COMPLETED", "FAILURE", "https://github.com.evil.example/TheRizz/personal-website/x"),
      { stage: "ci_failed", runUrl: null, write: true },
    ],
  ] as const)("%s", (_name, pr, run, expected) => {
    expect(derivePrStage(pr, SHA, run)).toEqual(expected);
  });
});

describe("deriveDeployStage", () => {
  const run = (status: string, conclusion: string | null, url = RUN) => ({
    status,
    conclusion,
    html_url: url,
  });
  it.each([
    ["live", true, null, { stage: "live", runUrl: null }],
    ["no run yet", false, null, { stage: "merged", runUrl: null }],
    ["queued", false, run("queued", null), { stage: "deploying", runUrl: RUN }],
    ["in progress", false, run("in_progress", null), { stage: "deploying", runUrl: RUN }],
    ["succeeded", false, run("completed", "success"), { stage: "live", runUrl: null }],
    [
      "cancelled by a newer deploy",
      false,
      run("completed", "cancelled"),
      { stage: "deploying", runUrl: null },
    ],
    ["failed", false, run("completed", "failure"), { stage: "deploy_failed", runUrl: RUN }],
    ["timed out", false, run("completed", "timed_out"), { stage: "deploy_failed", runUrl: RUN }],
    [
      "failed with a link elsewhere",
      false,
      run("completed", "failure", "https://user@github.com/TheRizz/personal-website/x"),
      { stage: "deploy_failed", runUrl: null },
    ],
  ] as const)("%s", (_name, live, deploy, expected) => {
    expect(deriveDeployStage(live, deploy)).toEqual(expected);
  });
});

describe("before the merge", () => {
  it("answers a draft and a published draft from D1 alone", async () => {
    const id = crypto.randomUUID();
    sqlite
      .prepare(
        "INSERT INTO drafts (id, kind, slug, created_at, updated_at) VALUES (?, 'new', 'x', 0, 0)",
      )
      .run(id);
    expect((await status(id)).json).toEqual({
      stage: "draft",
      action: null,
      pr: null,
      prUrl: null,
      branch: null,
      runUrl: null,
      mergeSha: null,
      slug: "x",
      mergedOtherVersion: false,
    });
    sqlite
      .prepare(
        "UPDATE drafts SET status = 'published', pr_number = 3, merge_sha = ?, " +
          "pr_action = 'publish' WHERE id = ?",
      )
      .run(SHA, id);
    expect((await status(id)).json).toMatchObject({
      stage: "live",
      action: "publish",
      pr: 3,
      prUrl: "https://github.com/TheRizz/personal-website/pull/3",
      mergeSha: SHA,
    });
    expect(fake.requests).toEqual([]);
    expect((await status(crypto.randomUUID())).status).toBe(404);
  });

  it("walks opened, CI running and review with one query each, writing nothing", async () => {
    const { id, pr, head } = await opened();
    startPolling();
    expect((await status(id)).json).toMatchObject({
      stage: "opened",
      pr,
      branch: row(id).pr_branch,
    });
    fake.setCi(head, { status: "QUEUED" });
    expect((await status(id)).json.stage).toBe("ci_running");
    fake.setCi(head, { status: "COMPLETED", conclusion: "SUCCESS" });
    expect((await status(id)).json.stage).toBe("review");
    expect((await status(id)).json.stage).toBe("review");
    expect(fake.requests.map(routeOf)).toEqual(Array(4).fill("POST /graphql PublishStatus"));
    expect(writes()).toEqual([]);
  });

  it("records a CI failure's run link, drops a link off GitHub, and clears it on a pass", async () => {
    const { id, head } = await opened();
    fake.setCi(head, { status: "COMPLETED", conclusion: "FAILURE", detailsUrl: RUN });
    const failed = await status(id);
    expect(failed.json).toMatchObject({ stage: "ci_failed", runUrl: RUN });
    expect(row(id)).toMatchObject({ status: "publishing", publish_error: RUN });
    fake.setCi(head, {
      status: "COMPLETED",
      conclusion: "FAILURE",
      detailsUrl: "https://evil.example/TheRizz/personal-website/actions/runs/7",
    });
    expect((await status(id)).json).toMatchObject({ stage: "ci_failed", runUrl: null });
    expect(row(id).publish_error).toBeNull();
    sqlite.prepare("UPDATE drafts SET publish_error = ? WHERE id = ?").run(RUN, id);
    fake.setCi(head, { status: "COMPLETED", conclusion: "SUCCESS" });
    expect((await status(id)).json.stage).toBe("review");
    expect(row(id).publish_error).toBeNull();
  });

  it("calls a head GitHub hasn't caught up with opened, and writes nothing", async () => {
    const { id, pr } = await opened();
    sqlite.prepare("UPDATE drafts SET publish_error = ? WHERE id = ?").run(RUN, id);
    const other = await fake.openPullFrom("blog/other-1", {});
    fake.pulls.get(pr)!.headSha = other.headSha;
    fake.setCi(other.headSha, { status: "COMPLETED", conclusion: "FAILURE" });
    startPolling();
    expect((await status(id)).json).toMatchObject({ stage: "opened", runUrl: null });
    expect(row(id).publish_error).toBe(RUN);
    expect(writes()).toEqual([]);
  });

  it.each([
    ["another branch", { head: "blog/someone-else-1" }],
    ["a fork", { headRepo: "someone/personal-website" }],
  ])("refuses a PR from %s with 502 and no writes", async (_name, change) => {
    const { id, pr } = await opened();
    Object.assign(fake.pulls.get(pr)!, change);
    startPolling();
    const { status: code, json } = await status(id);
    expect([code, json.error.code]).toEqual([502, "pr_mismatch"]);
    expect(writes()).toEqual([]);
  });

  it("answers 503 with no writes when the App can't see the repository", async () => {
    const { id } = await opened();
    fake.repositoryGone = true;
    startPolling();
    const { status: code, json } = await status(id);
    expect([code, json.error.code]).toEqual([503, "github_unavailable"]);
    expect(writes()).toEqual([]);
    expect(row(id).status).toBe("publishing");
  });

  it("puts a new post back to Draft when its PR closes, and deletes the branch", async () => {
    const { id, pr } = await opened();
    const branch = String(row(id).pr_branch);
    fake.closePull(pr);
    const { json } = await status(id);
    expect(json).toMatchObject({ stage: "closed", pr, action: "publish", slug: null });
    await Promise.all(pending);
    expect(fake.refs.has(branch)).toBe(false);
    expect(row(id)).toMatchObject({
      status: "draft",
      kind: "new",
      slug: null,
      source_path: null,
      post_date: null,
      pr_number: null,
      pr_branch: null,
      head_sha: null,
      pr_action: null,
      pr_blob_sha: null,
    });
  });

  it("keeps the slug of a new post that went live once, and an edit's path", async () => {
    const first = await opened();
    sqlite.prepare("UPDATE drafts SET published_at = 1, pr_number = 77 WHERE id = ?").run(first.id);
    expect((await status(first.id)).json.stage).toBe("closed");
    expect(row(first.id)).toMatchObject({ slug: SLUG, source_path: null, status: "draft" });

    const { json: imported } = await call("POST", "/api/admin/posts/hello-world/import", {});
    sqlite.prepare("UPDATE drafts SET summary = 'New.', rev = 2 WHERE id = ?").run(imported.id);
    const published = await call("POST", `/api/admin/drafts/${imported.id}/publish`, {
      baseRev: 2,
      date: TODAY,
    });
    fake.closePull(published.json.pr);
    expect((await status(imported.id)).json.stage).toBe("closed");
    expect(row(imported.id)).toMatchObject({
      kind: "edit",
      slug: "hello-world",
      source_path: HELLO_PATH,
      post_date: "2026-10-11",
      status: "draft",
    });
  });
});

describe("the merge", () => {
  it("records the merge and marks the merged file's images in the same batch", async () => {
    const [shown, quoted, mentioned, unused] = [img(1), img(2), img(3), img(4)];
    const body = `Intro.\n\n${figure(shown)}\n\n> ${figure(quoted)}\n\nSee \`${mentioned}\`.\n`;
    const { id, pr } = await opened(body, [shown, quoted]);
    addImage(id, mentioned, "pending");
    addImage(id, unused);
    sqlite
      .prepare("UPDATE images SET state = 'orphan', orphaned_at = 1 WHERE id = ?")
      .run(quoted.slice(5, 41));
    const mergeSha = await fake.mergePull(pr);
    startPolling();

    const { json } = await status(id);
    expect(json).toMatchObject({ stage: "merged", mergeSha, mergedOtherVersion: false });
    const merged = fake.filesAt(mergeSha).get(PATH)!;
    expect(row(id)).toMatchObject({
      status: "publishing",
      merge_sha: mergeSha,
      kind: "edit",
      base_sha: await gitBlobSha(merged),
      post_date: TODAY,
      source_path: PATH,
    });
    expect(imageRow(shown)).toEqual({ state: "ready", published: 1 });
    expect(imageRow(quoted)).toEqual({ state: "ready", published: 1 });
    expect(imageRow(mentioned)).toEqual({ state: "pending", published: 0 });
    expect(imageRow(unused)).toEqual({ state: "ready", published: 0 });

    // After the merge, GraphQL is skipped: only the deploy is checked.
    startPolling();
    expect((await status(id)).json.stage).toBe("merged");
    expect(fake.requests.map(routeOf)).toEqual([
      "GET /repos/:repo/actions/workflows/deploy.yml/runs",
    ]);
    vi.stubGlobal("__APP_VERSION__", mergeSha);
    expect((await status(id)).json.stage).toBe("live");
    expect(imageRow(shown)).toEqual({ state: "ready", published: 1 });
  });

  it("marks every publish revision's images when the merged text is truncated", async () => {
    const [first, second] = [img(5), img(6)];
    const { id, pr } = await opened(`One.\n\n${figure(first)}\n`, [first]);
    sqlite
      .prepare("UPDATE drafts SET body_md = ?, rev = 2 WHERE id = ?")
      .run(`Two.\n\n${figure(second)}\n`, id);
    addImage(id, second);
    const republished = await call("POST", `/api/admin/drafts/${id}/publish`, {
      baseRev: 2,
      date: TODAY,
    });
    expect(republished.status).toBe(202);
    fake.largeFiles.add(PATH);
    await fake.mergePull(pr);
    expect((await status(id)).json.stage).toBe("merged");
    expect(imageRow(first)).toEqual({ state: "ready", published: 1 });
    expect(imageRow(second)).toEqual({ state: "ready", published: 1 });
    expect(row(id).post_date).toBe(TODAY);
  });

  it("does neither when the batch fails, and the next poll does both", async () => {
    const src = img(7);
    const { id, pr } = await opened(`Text.\n\n${figure(src)}\n`, [src]);
    await fake.mergePull(pr);
    const working = env.DB;
    env.DB = Object.assign(Object.create(working) as D1Database, {
      batch: async () => {
        throw new Error("D1_ERROR: busy");
      },
    });
    expect((await status(id)).status).toBe(500);
    expect(row(id).merge_sha).toBeNull();
    expect(imageRow(src)).toEqual({ state: "ready", published: 0 });
    env.DB = working;
    expect((await status(id)).json.stage).toBe("merged");
    expect(row(id).merge_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(imageRow(src)).toEqual({ state: "ready", published: 1 });
  });

  it("flags a merge of a version other than the last one pushed", async () => {
    const { id, pr } = await opened();
    sqlite.prepare("UPDATE drafts SET pr_blob_sha = ? WHERE id = ?").run(OTHER_SHA, id);
    await fake.mergePull(pr);
    expect((await status(id)).json).toMatchObject({ stage: "merged", mergedOtherVersion: true });
  });
});

describe("the deploy", () => {
  async function merged() {
    const { id, pr } = await opened();
    const mergeSha = await fake.mergePull(pr);
    expect((await status(id)).json.stage).toBe("merged");
    return { id, pr, mergeSha };
  }

  it("is live when the site serves the merge commit, and stays so with no calls", async () => {
    const { id, pr, mergeSha } = await merged();
    vi.stubGlobal("__APP_VERSION__", mergeSha);
    startPolling();
    expect((await status(id)).json).toEqual({
      stage: "live",
      action: "publish",
      pr,
      prUrl: `https://github.com/TheRizz/personal-website/pull/${pr}`,
      branch: null,
      runUrl: null,
      mergeSha,
      slug: SLUG,
      mergedOtherVersion: false,
    });
    expect(fake.requests).toEqual([]);
    expect(row(id)).toMatchObject({
      status: "published",
      published_at: NOW,
      pr_branch: null,
      head_sha: null,
      pr_number: pr,
      merge_sha: mergeSha,
      pr_action: "publish",
    });
    startPolling();
    expect((await status(id)).json.stage).toBe("live");
    expect(fake.requests).toEqual([]);
  });

  it("is live when the site serves a later commit that contains the merge", async () => {
    const { id } = await merged();
    vi.stubGlobal("__APP_VERSION__", await fake.setMainFile("content/blog/x.md", "later"));
    startPolling();
    expect((await status(id)).json.stage).toBe("live");
    expect(fake.requests.map(routeOf)).toEqual(["GET /repos/:repo/compare/:base...:head"]);
  });

  it("reads the stub's version through the local override", async () => {
    const { id, mergeSha } = await merged();
    env.GITHUB_API_BASE = "http://127.0.0.1:5999";
    fake.version = mergeSha;
    resetGitHubCaches();
    const local = new Request(`http://localhost:4173/api/admin/drafts/${id}/status`);
    const response = await handlePublishing(local, env, ctx);
    expect(JSON.parse(await response!.text()).stage).toBe("live");
    expect(fake.requests.at(-1)!.url).toBe("http://127.0.0.1:5999/__e2e/health");
  });

  it("follows the deploy run: deploying, cancelled, failed, then live", async () => {
    const { id, mergeSha } = await merged();
    fake.addDeploy(mergeSha, "in_progress", null, 7);
    expect((await status(id)).json).toMatchObject({ stage: "deploying", runUrl: RUN });
    fake.addDeploy(mergeSha, "completed", "cancelled", 8);
    expect((await status(id)).json).toMatchObject({ stage: "deploying", runUrl: null });
    expect(row(id).status).toBe("publishing");
    fake.addDeploy(mergeSha, "completed", "failure", 7);
    expect((await status(id)).json).toMatchObject({ stage: "deploy_failed", runUrl: RUN });
    expect(row(id)).toMatchObject({ status: "failed", publish_error: RUN });
    statements.splice(0);
    expect((await status(id)).json.stage).toBe("deploy_failed");
    expect(writes()).toEqual([]);
    fake.addDeploy(mergeSha, "completed", "success", 9);
    expect((await status(id)).json.stage).toBe("live");
    expect(row(id)).toMatchObject({ status: "published", publish_error: null });
  });

  it("turns an unpublished post into a new post once it is gone", async () => {
    const unpublished = await call("POST", "/api/admin/posts/hello-world/unpublish", {});
    const id = unpublished.json.draftId as string;
    const mergeSha = await fake.mergePull(unpublished.json.pr);
    expect((await status(id)).json).toMatchObject({ stage: "merged", action: "unpublish" });
    expect(row(id)).toMatchObject({
      kind: "new",
      source_path: null,
      base_sha: null,
      post_date: null,
    });
    vi.stubGlobal("__APP_VERSION__", mergeSha);
    expect((await status(id)).json).toMatchObject({
      stage: "live",
      action: "unpublish",
      mergeSha,
      slug: "hello-world",
    });
    expect(row(id)).toMatchObject({
      kind: "new",
      status: "draft",
      slug: "hello-world",
      pr_number: null,
      merge_sha: null,
      pr_action: null,
    });
  });
});
