import { exportPKCS8, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "./admin";
import { createD1 } from "./d1-fake";
import { resetGitHubCaches } from "./github";
import {
  FAKE_CLIENT_ID,
  FAKE_INSTALLATION_ID,
  auditRequests,
  createGitHubFake,
  type GitHubFake,
} from "./github-fake";
import { resetPostsCache } from "./posts";
import { createR2 } from "./r2-fake";

// Draft privacy, end to end (design doc §4.9.9 "Guards in CI", execution plan Step 10.11). A
// private draft with revisions and images, and an unpublished edit of a post on `main`, sit in D1
// while another draft is published through the real admin router, republished, merged on the
// GitHub fake and polled until Live. Then none of the private text, image ids or draft ids may
// appear in any GitHub request, in anything the content build writes from the merged `main`
// (all of its output directory, so the RSS feed, the sitemap and the search index are covered
// once the build makes them), or in anything logged. publish.test.ts audits each flow's requests
// on its own; this test follows one post the whole way.

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

const A_IMAGE = "blog/aaaaaaaa-1111-4111-8111-111111111111.webp";
const A_OLD_IMAGE = "blog/aaaaaaaa-2222-4222-8222-222222222222.webp";
const B_IMAGE = "blog/bbbbbbbb-3333-4333-8333-333333333333.webp";
const FIXTURE_IMAGE = "blog/cccccccc-4444-4444-8444-444444444444.webp";
/** An image's id, which every variant key and preview URL of it holds. */
const imageId = (src: string) => src.slice("blog/".length, -".webp".length);
const figure = (src: string, caption: string, alt: string) =>
  `::figure[${caption}]{src="${src}" alt="${alt}" w="2048" h="1365"}`;

/** What only drafts that never go live hold, by name. None of it may appear in any output. */
const PRIVATE: [string, string][] = [
  ["draft A's title", "zq-a-title"],
  ["draft A's summary", "zq-a-summary"],
  ["draft A's category", "zq-a-category"],
  ["draft A's tag", "zq-a-tag"],
  ["draft A's heading", "zq-a-heading"],
  ["draft A's body text", "zq-a-text"],
  ["draft A's figure caption", "zq-a-caption"],
  ["draft A's figure alt", "zq-a-alt"],
  ["draft A's manual revision", "zq-a-manual"],
  ["draft A's conflict revision", "zq-a-conflict"],
  ["draft A's image", imageId(A_IMAGE)],
  ["draft A's earlier image", imageId(A_OLD_IMAGE)],
  ["draft B's removed text", "zq-b-removed"],
  ["the unpublished edit of hello-world", "zq-edit"],
];

const A_BODY = `Plans in zq-a-text.

## Next zq-a-heading

${figure(A_IMAGE, "Caption zq-a-caption", "Alt zq-a-alt")}
`;
const A_MANUAL_BODY = `${A_BODY}
Notes zq-a-manual.

${figure(A_OLD_IMAGE, "Earlier", "Earlier picture")}
`;
const A_CONFLICT_BODY = `${A_BODY}\nOther tab zq-a-conflict.\n`;

const B_TITLE = "Bright notes zq-b-title";
const B_BODY = `Intro to zq-b-text.

${figure(B_IMAGE, "The view", "A bright view")}

## Setup

More zq-b-text.
`;
const B_REMOVED = `\n## Scratch zq-b-removed\n\nWords zq-b-removed.\n`;
const B_LATER = `\n## Later\n\nA later section.\n`;

/**
 * A post on `main` marked `draft: true`, which the build must leave out. Its markers are single
 * words and one is its slug: a sitemap holds only slugs and a search index only the words of a
 * text (an id split at its hyphens), so neither could keep the post without showing one.
 */
const FIXTURE_DRAFT_PATH = "content/blog/2026-10-12-zqfixtureslug.md";
const FIXTURE_DRAFT = `---
title: "Unfinished zqfixturedraft"
date: 2026-10-12
summary: "Not ready zqfixturedraft."
tags: [zqfixturetag]
draft: true
---

Words zqfixturedraft.

${figure(FIXTURE_IMAGE, "zqfixturedraft", "zqfixturedraft")}
`;
const FIXTURE_PRIVATE: [string, string][] = [
  ["the draft: true post's text", "zqfixturedraft"],
  ["the draft: true post's slug", "zqfixtureslug"],
  ["the draft: true post's tag", "zqfixturetag"],
  ["the draft: true post's image", imageId(FIXTURE_IMAGE)],
  ["the draft: true post's image, split at hyphens", imageId(FIXTURE_IMAGE).split("-").at(-1)!],
];

let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let fake: GitHubFake;
let env: Env;
let pending: Promise<unknown>[];
/** Every console call, by method. Vitest clears a spy's calls before each test, so they go here. */
const logs: [string, unknown[]][] = [];
const ctx = {
  waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  passThroughOnException() {},
} as unknown as ExecutionContext;
/** The console methods that print; the others (`trace`, `table`, `assert`...) call one of them. */
const LOG_METHODS = ["log", "info", "warn", "error", "debug", "dir"] as const;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const method of LOG_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push([method, args]);
    });
  }
  resetGitHubCaches();
  resetPostsCache();
  pending = [];
  ({ db, sqlite } = await createD1());
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  fake = await createGitHubFake({ publicKey, files: { [HELLO_PATH]: HELLO } });
  vi.stubGlobal("fetch", fake.fetch);
  env = {
    DB: db,
    PHOTOS: createR2().bucket,
    OWNER_EMAIL: OWNER,
    GIT_AUTHOR: "TheRizz <19941577+TheRizz@users.noreply.github.com>",
    GITHUB_APP_CLIENT_ID: FAKE_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: FAKE_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
  } as unknown as Env;

  await seedPrivateDraft();
  await seedUnpublishedEdit();
  await publishUntilLive();
  await Promise.all(pending);
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`${SITE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const notAPage = async () => new Response("not an API route", { status: 500 });
  const response = await handleAdmin(request, env, { email: OWNER }, notAPage, ctx);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

/** A call that must answer `status`. */
async function expectCall(status: number, method: string, path: string, body?: unknown) {
  const response = await call(method, path, body);
  expect(response.status, `${method} ${path}`).toBe(status);
  return response.json;
}

function addImage(draftId: string, src: string) {
  const [, id, ext] = /^blog\/(.+)\.(\w+)$/.exec(src)!;
  sqlite
    .prepare(
      "INSERT INTO images (id, draft_id, ext, width, height, state, created_at) " +
        "VALUES (?, ?, ?, 2048, 1365, 'ready', 0)",
    )
    .run(id, draftId, ext);
}

const save = (id: string, fields: Record<string, unknown>) =>
  expectCall(200, "PUT", `/api/admin/drafts/${id}`, fields);

/**
 * Draft A, never published: every field holds a marker, a manual revision holds an earlier body
 * with another image, and a conflict revision the version an Overwrite replaced.
 */
async function seedPrivateDraft() {
  const { id } = await expectCall(201, "POST", "/api/admin/drafts", {
    title: "Private plans zq-a-title",
    summary: "Nobody reads this zq-a-summary.",
    category: "zq-a-category",
    tags: ["zq-a-tag"],
    bodyMd: A_BODY,
  });
  addImage(id, A_IMAGE);
  addImage(id, A_OLD_IMAGE);
  await save(id, { baseRev: 1, bodyMd: A_MANUAL_BODY, revision: "manual" });
  await save(id, { baseRev: 2, bodyMd: A_CONFLICT_BODY });
  await save(id, { baseRev: 3, bodyMd: A_BODY, revision: "conflict" });
  const revisions = sqlite
    .prepare("SELECT rev, reason FROM draft_revisions WHERE draft_id = ? ORDER BY rev")
    .all(id);
  expect(revisions).toEqual([
    { rev: 2, reason: "manual" },
    { rev: 3, reason: "conflict" },
  ]);
}

/** The post on `main`, imported and edited, never published. */
async function seedUnpublishedEdit() {
  const { id } = await expectCall(201, "POST", "/api/admin/posts/hello-world/import", {});
  const draft = await expectCall(200, "GET", `/api/admin/drafts/${id}`);
  await save(id, { baseRev: draft.rev, bodyMd: `${draft.bodyMd}\nAn edit zq-edit.\n` });
}

/** Polls the status until it shows `stage`; GitHub shows a pushed head a poll late. */
async function statusUntil(id: string, stage: string) {
  for (let poll = 0; poll < 3; poll++) {
    const state = await expectCall(200, "GET", `/api/admin/drafts/${id}/status`);
    if (state.stage === stage) return state;
  }
  throw new Error(`the status never showed ${stage}`);
}

/**
 * Draft B: a section saved in a manual revision and removed again, a publish that fails once on
 * GitHub after its branch is pushed (so the clean-up runs and publishing logs) and then opens
 * the PR, an edit and a republish, CI, the owner's merge, and Live.
 */
async function publishUntilLive() {
  const { id } = await expectCall(201, "POST", "/api/admin/drafts", {
    title: B_TITLE,
    summary: "A post that goes live.",
    category: "notes",
    tags: ["workers"],
    bodyMd: B_BODY,
  });
  addImage(id, B_IMAGE);
  await save(id, { baseRev: 1, bodyMd: `${B_BODY}${B_REMOVED}`, revision: "manual" });
  await save(id, { baseRev: 2, bodyMd: B_BODY });

  fake.override("POST", "/repos/:repo/pulls", Response.json({}, { status: 500 }));
  await expectCall(502, "POST", `/api/admin/drafts/${id}/publish`, { baseRev: 3, date: TODAY });
  expect([...fake.refs.keys()]).toEqual(["main"]);
  const opened = await expectCall(202, "POST", `/api/admin/drafts/${id}/publish`, {
    baseRev: 3,
    date: TODAY,
  });

  await save(id, { baseRev: 3, bodyMd: `${B_BODY}${B_LATER}` });
  const republished = await expectCall(202, "POST", `/api/admin/drafts/${id}/publish`, {
    baseRev: 4,
    date: TODAY,
  });
  expect(republished).toMatchObject({ pr: opened.pr, republished: true });
  expect(republished.warnings).toBeUndefined();

  const head = sqlite.prepare("SELECT head_sha FROM drafts WHERE id = ?").all(id)[0]!.head_sha;
  fake.setCi(String(head), { status: "COMPLETED", conclusion: "SUCCESS" });
  await statusUntil(id, "review");
  const mergeSha = await fake.mergePull(opened.pr);
  await statusUntil(id, "merged");
  vi.stubGlobal("__APP_VERSION__", mergeSha);
  await statusUntil(id, "live");

  const published = sqlite.prepare("SELECT id FROM images WHERE published = 1").all();
  expect(published).toEqual([{ id: imageId(B_IMAGE) }]);
}

/** Every draft id in D1, which no output may hold. */
const draftIds = (): [string, string][] =>
  sqlite
    .prepare("SELECT id FROM drafts")
    .all()
    .map((row) => ["a draft id", String(row.id)]);

/** One line per output that holds one of `values`, naming both. */
function leaks(outputs: [string, string][], values: [string, string][]): string[] {
  return outputs.flatMap(([output, text]) =>
    values.filter(([, value]) => text.includes(value)).map(([name]) => `${output} holds ${name}`),
  );
}

describe("a private draft, while another post is published", () => {
  it("reaches GitHub in no request, PR, comment or commit", () => {
    const sent: [string, string][] = fake.requests.map((r) => [
      `${r.method} ${r.route ?? r.path}`,
      `${r.url}\n${JSON.stringify(r.headers)}\n${r.text ?? ""}`,
    ]);
    const stored: [string, string][] = [
      ...[...fake.pulls.values()].flatMap((pull): [string, string][] => [
        [`PR #${pull.number} title`, pull.title],
        [`PR #${pull.number} body`, pull.body],
        ...pull.comments.map((comment, i): [string, string] => [
          `PR #${pull.number} comment ${i + 1}`,
          comment,
        ]),
      ]),
      ...[...fake.commits.values()].flatMap((commit): [string, string][] => [
        [`commit ${commit.sha.slice(0, 7)} message`, commit.message],
        ...[...fake.filesAt(commit.sha)].map(([path, text]): [string, string] => [
          `${path} at ${commit.sha.slice(0, 7)}`,
          text,
        ]),
      ]),
    ];
    const forbidden = [...PRIVATE, ...draftIds()];
    expect(leaks([...sent, ...stored], forbidden)).toEqual([]);
    expect(
      auditRequests(fake.requests, {
        ownerEmail: OWNER,
        forbidden: forbidden.map(([, value]) => value),
      }),
    ).toEqual([]);
    // The published post did go out, so the scan reads what was sent.
    const pull = fake.pulls.get(1)!;
    expect([pull.title, pull.comments.length]).toEqual([`Publish: ${B_TITLE}`, 1]);
    expect(sent.some(([, text]) => text.includes("More zq-b-text."))).toBe(true);
  });

  it("is in nothing the content build writes from main", { timeout: 120_000 }, async () => {
    const files = new Map(
      [...fake.mainFiles()].filter(([path]) => path.startsWith("content/blog/")),
    );
    files.set(FIXTURE_DRAFT_PATH, FIXTURE_DRAFT);
    const { outputs, log } = await buildContent(files);
    const forbidden = [...PRIVATE, ...FIXTURE_PRIVATE, ...draftIds()];
    expect(leaks([...outputs, ["the build's output", log]], forbidden)).toEqual([]);
    // The merged post is there, so the scan reads what was built.
    const posts = outputs.find(([file]) => file === "posts.json")?.[1] ?? "";
    for (const text of [B_TITLE, "More zq-b-text.", imageId(B_IMAGE), "Hello, world"]) {
      expect(posts).toContain(text);
    }
  });

  it("is never logged, nor is the published post's text, image or owner's address", async () => {
    const { inspect } = await nodeApis();
    const calls = logs.map(([method, args], n): [string, string] => [
      `console.${method} (call ${n + 1})`,
      args.map((arg) => logged(inspect, arg)).join(" "),
    ]);
    const forbidden: [string, string][] = [
      ...PRIVATE,
      ...draftIds(),
      ["draft B's title, slug or path", "zq-b-title"],
      ["draft B's body text", "zq-b-text"],
      ["draft B's image", imageId(B_IMAGE)],
      ["the owner's address", OWNER],
    ];
    expect(leaks(calls, forbidden)).toEqual([]);
    // The failed publish was logged, so the spies saw the flow.
    expect(logs).toContainEqual([
      "error",
      ["Publishing failed:", "GitHubError", "POST /repos/:repo/pulls", 500],
    ]);
  });
});

/**
 * A logged argument as the console prints it: a string as is, anything else inspected in full,
 * so an error's cause, an error inside an object, a Request's URL and a Map's entries all show.
 */
function logged(inspect: NodeApis["inspect"], value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, {
    depth: Infinity,
    maxStringLength: Infinity,
    maxArrayLength: Infinity,
    breakLength: Infinity,
  });
}

// ---- The content build, run as CI runs it ----

/**
 * The Node APIs the build needs, typed by hand: the Worker's tsconfig has no Node types, so they
 * are imported the way d1-fake.ts imports node:sqlite.
 */
interface NodeApis {
  fs: {
    mkdtemp(prefix: string): Promise<string>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, text: string): Promise<void>;
    readFile(path: string, encoding: "utf8"): Promise<string>;
    readdir(
      path: string,
      options: { recursive: true; withFileTypes: true },
    ): Promise<{ name: string; parentPath: string; isFile(): boolean }[]>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  };
  path: {
    join(...parts: string[]): string;
    dirname(path: string): string;
    relative(from: string, to: string): string;
  };
  tmpdir(): string;
  fileURLToPath(url: URL): string;
  inspect(
    value: unknown,
    options: {
      depth: number;
      maxStringLength: number;
      maxArrayLength: number;
      breakLength: number;
    },
  ): string;
  execFile(
    file: string,
    args: string[],
    options: { cwd: string; timeout: number },
    done: (error: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void,
  ): void;
}

async function nodeApis(): Promise<NodeApis> {
  const [fs, path, os, url, util, childProcess] = await Promise.all([
    import("node:fs/promises" as string),
    import("node:path" as string),
    import("node:os" as string),
    import("node:url" as string),
    import("node:util" as string),
    import("node:child_process" as string),
  ]);
  return {
    fs,
    path,
    tmpdir: os.tmpdir,
    fileURLToPath: url.fileURLToPath,
    inspect: util.inspect,
    execFile: childProcess.execFile,
  };
}

/**
 * Writes `files` (repo paths to text) to a temporary tree and runs scripts/build-content.ts on it.
 * Returns every file the build wrote, by its path in the output directory, and what it printed.
 */
async function buildContent(
  files: Map<string, string>,
): Promise<{ outputs: [string, string][]; log: string }> {
  const { fs, path, tmpdir, fileURLToPath, execFile } = await nodeApis();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const temp = await fs.mkdtemp(path.join(tmpdir(), "draft-privacy-"));
  try {
    for (const [file, text] of files) {
      await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true });
      await fs.writeFile(path.join(temp, file), text);
    }
    const out = path.join(temp, "out");
    const args = ["scripts/build-content.ts", "--content", path.join(temp, "content")];
    // A build that hangs is killed before the test's own timeout, so the tree is still removed.
    const log = await new Promise<string>((resolve, reject) =>
      execFile(
        path.join(root, "node_modules/.bin/tsx"),
        [...args, "--out", out],
        { cwd: root, timeout: 110_000 },
        (error, stdout, stderr) =>
          error
            ? reject(new Error(`build-content ${error.killed ? "timed out" : "failed"}: ${stderr}`))
            : resolve(stdout + stderr),
      ),
    );
    const entries = await fs.readdir(out, { recursive: true, withFileTypes: true });
    const outputs = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry): Promise<[string, string]> => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(out, file), await fs.readFile(file, "utf8")];
        }),
    );
    return { outputs, log };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
