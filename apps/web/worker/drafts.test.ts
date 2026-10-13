import { figureWidths, variantKey } from "@site/content-markdown/figure";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createD1 } from "./d1-fake";
import { MAX_BODY_BYTES, REVISION_CAP, handleDrafts } from "./drafts";
import { createR2, type StoredObject } from "./r2-fake";

// The drafts API against a real SQLite database with the shipped migrations (d1-fake.ts), and an
// in-memory R2 bucket for the images a discard deletes (r2-fake.ts).

const SITE = "https://ry-mart.com";
let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let photos: R2Bucket;
let objects: Map<string, StoredObject>;

beforeEach(async () => {
  ({ db, sqlite } = await createD1());
  ({ bucket: photos, objects } = createR2());
});

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`${SITE}/api/admin/drafts${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await handleDrafts(request, { DB: db, PHOTOS: photos });
  if (!response) throw new Error(`no route for ${method} ${path}`);
  const text = await response.text();
  return { status: response.status, response, json: text ? JSON.parse(text) : undefined };
}

async function create(fields: Record<string, unknown> = {}) {
  const { status, json } = await call("POST", "", fields);
  expect(status).toBe(201);
  return json as { id: string; rev: number };
}

const revisions = (id: string) =>
  sqlite
    .prepare("SELECT rev, reason, title FROM draft_revisions WHERE draft_id = ? ORDER BY rev")
    .all(id);

describe("create, list and load", () => {
  it("creates an empty draft at rev 1 and loads it", async () => {
    const { id, rev } = await create();
    expect(rev).toBe(1);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const { status, json, response } = await call("GET", `/${id}`);
    expect(status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toMatchObject({
      id,
      kind: "new",
      title: "",
      summary: "",
      category: null,
      tags: [],
      bodyMd: "",
      rev: 1,
      status: "draft",
    });
  });

  it("normalises tags and lists drafts newest first", async () => {
    const first = await create({ title: "First", tags: ["Durable Objects", "durable-objects"] });
    const second = await create({ title: "Second" });
    expect((await call("GET", `/${first.id}`)).json.tags).toEqual(["durable-objects"]);
    sqlite.prepare("UPDATE drafts SET updated_at = 1 WHERE id = ?").run(first.id);
    const { json } = await call("GET", "");
    expect(json.drafts.map((d: { title: string }) => d.title)).toEqual(["Second", "First"]);
    expect(json.drafts[0]).not.toHaveProperty("bodyMd");
    expect(json.drafts[0].id).toBe(second.id);
  });

  it("is 404 for an unknown or malformed id", async () => {
    expect((await call("GET", "/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call("GET", "/not-an-id")).status).toBe(404);
    expect((await call("PUT", "/x/revisions/abc/restore")).status).toBe(404);
  });

  it("answers wrong methods with 405 and leaves other paths alone", async () => {
    expect((await call("PATCH", "")).status).toBe(405);
    const other = new Request(`${SITE}/api/admin/posts`);
    expect(await handleDrafts(other, { DB: db, PHOTOS: photos })).toBeNull();
  });
});

describe("validation", () => {
  it.each([
    [{ title: 5 }, 422],
    [{ tags: "a" }, 422],
    [{ tags: ["!!!"] }, 422],
    [{ summary: "x".repeat(301) }, 422],
    [{ draft: true }, 422],
    [[1], 400],
    ["{not json", 400],
  ])("refuses %j with %i", async (body, status) => {
    const response = await call("POST", "", body);
    expect(response.status).toBe(status);
    expect(response.json.error.code).toBeTypeOf("string");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM drafts").all()[0]).toEqual({ n: 0 });
  });

  it("caps the body at 512 KB of UTF-8", async () => {
    const atCap = "é".repeat(MAX_BODY_BYTES / 2);
    expect((await call("POST", "", { bodyMd: atCap })).status).toBe(201);
    expect((await call("POST", "", { bodyMd: `${atCap}x` })).status).toBe(413);
  });
});

describe("autosave", () => {
  it("saves against the current rev", async () => {
    const { id } = await create();
    const saved = await call("PUT", `/${id}`, { baseRev: 1, title: "Hello", bodyMd: "## Hi" });
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({ rev: 2 });
    const { json } = await call("GET", `/${id}`);
    expect(json).toMatchObject({ title: "Hello", bodyMd: "## Hi", rev: 2 });
    // A save without a reason keeps no revision.
    expect(revisions(id)).toEqual([]);
  });

  it("refuses a stale save with 409 and leaves the row unchanged", async () => {
    const { id } = await create();
    await call("PUT", `/${id}`, { baseRev: 1, bodyMd: "tab A" });
    const before = sqlite.prepare("SELECT * FROM drafts WHERE id = ?").all(id);
    const stale = await call("PUT", `/${id}`, { baseRev: 1, bodyMd: "tab B", revision: "manual" });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: { code: "conflict" }, rev: 2 });
    expect(stale.json.updatedAt).toBeTypeOf("number");
    expect(sqlite.prepare("SELECT * FROM drafts WHERE id = ?").all(id)).toEqual(before);
    expect(revisions(id)).toEqual([]);
  });

  it("is 404 when the draft is gone", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call("PUT", `/${missing}`, { baseRev: 1 })).status).toBe(404);
  });

  it("needs a baseRev and a known revision reason", async () => {
    const { id } = await create();
    expect((await call("PUT", `/${id}`, { title: "x" })).status).toBe(400);
    expect((await call("PUT", `/${id}`, { baseRev: "1" })).status).toBe(400);
    expect((await call("PUT", `/${id}`, { baseRev: 1, revision: "publish" })).status).toBe(400);
  });

  it("keeps a revision of the saved version on interval and manual saves", async () => {
    const { id } = await create();
    await call("PUT", `/${id}`, { baseRev: 1, title: "One", revision: "interval" });
    await call("PUT", `/${id}`, { baseRev: 2, title: "Two", revision: "manual" });
    expect(revisions(id)).toEqual([
      { rev: 2, reason: "interval", title: "One" },
      { rev: 3, reason: "manual", title: "Two" },
    ]);
  });

  it("Overwrite keeps the other tab's version as a conflict revision", async () => {
    const { id } = await create();
    await call("PUT", `/${id}`, { baseRev: 1, title: "Tab A", bodyMd: "A's text" });
    const conflict = await call("PUT", `/${id}`, { baseRev: 1, title: "Tab B" });
    expect(conflict.status).toBe(409);
    const overwrite = await call("PUT", `/${id}`, {
      baseRev: conflict.json.rev,
      title: "Tab B",
      bodyMd: "B's text",
      revision: "conflict",
    });
    expect(overwrite.json).toEqual({ rev: 3 });
    const kept = sqlite
      .prepare("SELECT rev, reason, title, body_md FROM draft_revisions WHERE draft_id = ?")
      .all(id);
    expect(kept).toEqual([{ rev: 2, reason: "conflict", title: "Tab A", body_md: "A's text" }]);
    expect((await call("GET", `/${id}`)).json).toMatchObject({ title: "Tab B", rev: 3 });
  });

  it(`caps revisions at ${REVISION_CAP} and keeps every publish revision`, async () => {
    const { id } = await create();
    sqlite
      .prepare(
        "INSERT INTO draft_revisions (draft_id, rev, title, body_md, meta, reason, created_at) " +
          "VALUES (?, 1, 'published', '', '{}', 'publish', 0)",
      )
      .run(id);
    let rev = 1;
    for (let i = 0; i < REVISION_CAP + 5; i++) {
      ({ rev } = (
        await call("PUT", `/${id}`, { baseRev: rev, title: `v${i}`, revision: "interval" })
      ).json as { rev: number });
    }
    const kept = revisions(id) as { rev: number; reason: string }[];
    expect(kept.filter((r) => r.reason === "publish")).toHaveLength(1);
    expect(kept.filter((r) => r.reason !== "publish")).toHaveLength(REVISION_CAP);
    expect(kept.at(-1)?.rev).toBe(rev);
    expect(kept[1]?.rev).toBe(rev - REVISION_CAP + 1);
  });
});

describe("revisions and restore", () => {
  it("lists revisions newest first and restores one as a new rev", async () => {
    const { id } = await create({ tags: ["one"] });
    await call("PUT", `/${id}`, {
      baseRev: 1,
      title: "Old",
      summary: "Old summary",
      bodyMd: "old",
      revision: "manual",
    });
    await call("PUT", `/${id}`, { baseRev: 2, title: "New", tags: ["two"], bodyMd: "new" });

    const list = await call("GET", `/${id}/revisions`);
    expect(list.json.revisions).toEqual([
      { rev: 2, title: "Old", reason: "manual", createdAt: expect.any(Number) },
    ]);

    const restored = await call("POST", `/${id}/revisions/2/restore`, { baseRev: 3 });
    expect(restored.json).toEqual({ rev: 4 });
    expect((await call("GET", `/${id}`)).json).toMatchObject({
      title: "Old",
      summary: "Old summary",
      tags: ["one"],
      bodyMd: "old",
      rev: 4,
    });
    expect(revisions(id)).toEqual([
      { rev: 2, reason: "manual", title: "Old" },
      { rev: 4, reason: "restore", title: "Old" },
    ]);
  });

  it("refuses a stale restore and an unknown revision", async () => {
    const { id } = await create();
    await call("PUT", `/${id}`, { baseRev: 1, title: "x", revision: "manual" });
    expect((await call("POST", `/${id}/revisions/2/restore`, { baseRev: 1 })).status).toBe(409);
    expect((await call("POST", `/${id}/revisions/9/restore`, { baseRev: 2 })).status).toBe(404);
    expect((await call("GET", `/${id}`)).json.rev).toBe(2);
  });
});

describe("discard", () => {
  it("deletes the draft and its revisions", async () => {
    const { id } = await create();
    await call("PUT", `/${id}`, { baseRev: 1, title: "x", revision: "manual" });
    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    expect((await call("GET", `/${id}`)).status).toBe(404);
    expect(revisions(id)).toEqual([]);
    expect((await call("DELETE", `/${id}`)).status).toBe(404);
  });

  it("refuses while a publish is open", async () => {
    const { id } = await create();
    sqlite.prepare("UPDATE drafts SET status = 'publishing' WHERE id = ?").run(id);
    expect((await call("DELETE", `/${id}`)).status).toBe(409);
    expect((await call("GET", `/${id}`)).status).toBe(200);
  });
});

describe("images", () => {
  /** An uploaded WebP of `draftId`: its row, and every variant in R2. */
  function addImage(draftId: string, { state = "ready", published = 0 } = {}) {
    const id = crypto.randomUUID();
    const src = `blog/${id}.webp`;
    const widths = figureWidths(src, 1024);
    sqlite
      .prepare(
        "INSERT INTO images (id, draft_id, ext, widths, width, height, state, published, " +
          "created_at) VALUES (?, ?, 'webp', ?, 1024, 683, ?, ?, 0)",
      )
      .run(id, draftId, JSON.stringify(widths), state, published);
    for (const width of widths) {
      objects.set(variantKey(src, width), { body: new Uint8Array([1]), httpMetadata: {} });
    }
    return { id, src };
  }
  const figure = (src: string) => `::figure[]{src="${src}" alt="A photo" w="1024" h="683"}`;
  const image = (id: string) =>
    sqlite.prepare("SELECT draft_id, state, orphaned_at FROM images WHERE id = ?").all(id)[0];
  const stored = (src: string) =>
    figureWidths(src, 1024).map((w) => objects.has(variantKey(src, w)));

  it("marks images the body drops as orphans, and ready again when they come back", async () => {
    const { id } = await create();
    const kept = addImage(id);
    const dropped = addImage(id);
    const uploading = addImage(id, { state: "pending" });
    const both = `${figure(kept.src)}\n\n${figure(dropped.src)}`;

    await call("PUT", `/${id}`, { baseRev: 1, bodyMd: figure(kept.src) });
    expect(image(kept.id)).toMatchObject({ state: "ready", orphaned_at: null });
    expect(image(dropped.id)).toMatchObject({ state: "orphan", orphaned_at: expect.any(Number) });
    // An upload still in progress isn't in the body yet, and isn't an orphan.
    expect(image(uploading.id)).toMatchObject({ state: "pending" });

    // A save without a body leaves the marks alone.
    await call("PUT", `/${id}`, { baseRev: 2, title: "Title only" });
    expect(image(dropped.id)).toMatchObject({ state: "orphan" });

    await call("PUT", `/${id}`, { baseRev: 3, bodyMd: both, revision: "manual" });
    expect(image(dropped.id)).toMatchObject({ state: "ready", orphaned_at: null });
  });

  it("a save that lands still succeeds when marking its images fails", async () => {
    const { id } = await create();
    const photo = addImage(id);
    const batch = db.batch.bind(db);
    const failing = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      if (statements.some((s) => /UPDATE images/.test((s as unknown as { sql: string }).sql))) {
        throw new Error("D1 is busy");
      }
      return batch(statements);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = await call("PUT", `/${id}`, { baseRev: 1, bodyMd: "No image." });
    expect(saved).toMatchObject({ status: 200, json: { rev: 2 } });
    expect(image(photo.id)).toMatchObject({ state: "ready" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(photo.id);
    failing.mockRestore();
    log.mockRestore();
    // The next save with a body marks it.
    await call("PUT", `/${id}`, { baseRev: 2, bodyMd: "Still no image." });
    expect(image(photo.id)).toMatchObject({ state: "orphan" });
  });

  it("only marks the draft's own images", async () => {
    const first = await create();
    const second = await create();
    const theirs = addImage(second.id);
    await call("PUT", `/${first.id}`, { baseRev: 1, bodyMd: "No images here." });
    expect(image(theirs.id)).toMatchObject({ state: "ready" });
  });

  it("restoring a revision marks against the restored body", async () => {
    const { id } = await create();
    const photo = addImage(id);
    await call("PUT", `/${id}`, { baseRev: 1, bodyMd: figure(photo.src), revision: "manual" });
    await call("PUT", `/${id}`, { baseRev: 2, bodyMd: "Gone." });
    expect(image(photo.id)).toMatchObject({ state: "orphan" });
    expect((await call("POST", `/${id}/revisions/2/restore`, { baseRev: 3 })).status).toBe(200);
    expect(image(photo.id)).toMatchObject({ state: "ready", orphaned_at: null });
  });

  it("discarding deletes the unpublished images, objects and rows", async () => {
    const { id } = await create();
    const ready = addImage(id);
    const orphan = addImage(id, { state: "orphan" });
    const pending = addImage(id, { state: "pending" });
    const published = addImage(id, { published: 1 });
    expect((await call("DELETE", `/${id}`)).status).toBe(204);

    for (const gone of [ready, orphan, pending]) {
      expect(image(gone.id)).toBeUndefined();
      expect(stored(gone.src)).toEqual([false, false]);
    }
    // A published image may be in a committed post, so it stays, without its draft.
    expect(image(published.id)).toMatchObject({ draft_id: null, state: "ready" });
    expect(stored(published.src)).toEqual([true, true]);
  });

  it("discarding keeps an image that another draft or its revisions still use", async () => {
    const { id } = await create();
    const inBody = addImage(id);
    const inRevision = addImage(id);
    // Only in another draft's current body: a plain autosave keeps no revision.
    await create({ bodyMd: figure(inBody.src) });
    // Only in another draft's revision.
    const other = await create();
    await call("PUT", `/${other.id}`, {
      baseRev: 1,
      bodyMd: figure(inRevision.src),
      revision: "manual",
    });
    await call("PUT", `/${other.id}`, { baseRev: 2, bodyMd: "Moved on." });

    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    expect(image(inBody.id)).toMatchObject({ draft_id: null });
    expect(image(inRevision.id)).toMatchObject({ draft_id: null });
    expect(stored(inBody.src)).toEqual([true, true]);
    expect(stored(inRevision.src)).toEqual([true, true]);
  });

  it("still discards when R2 fails, leaving the rows to the daily clean-up", async () => {
    const { id } = await create();
    const photo = addImage(id);
    photos = { ...photos, delete: () => Promise.reject(new Error("R2 is down")) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    expect(image(photo.id)).toMatchObject({ draft_id: null });
    // The log line names no draft or image.
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(photo.id);
    log.mockRestore();
  });

  it("deletes no images while a publish is open", async () => {
    const { id } = await create();
    const photo = addImage(id);
    sqlite.prepare("UPDATE drafts SET status = 'publishing' WHERE id = ?").run(id);
    expect((await call("DELETE", `/${id}`)).status).toBe(409);
    expect(image(photo.id)).toMatchObject({ draft_id: id });
    expect(stored(photo.src)).toEqual([true, true]);
  });
});
