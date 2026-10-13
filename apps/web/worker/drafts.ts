import { postFrontmatter } from "@site/content-schema";
import { jsonError, methodNotAllowed } from "./api";
import { deleteImages, type ImagesEnv, type StoredImage } from "./images";

// The drafts API on D1 (design doc §4.9.5, execution plan Step 10.4). The admin router mounts it
// behind the owner gate, so nothing here checks access. Every value reaches SQL as a bound
// parameter, and every statement in a batch carries its own rev guard, because a D1 batch keeps
// going when an UPDATE matches no rows. Saves also keep the draft's image rows in step with its
// body (design doc §4.9.6).

/** The largest draft body, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 512 * 1024;
/** The largest request, leaving room for the metadata around the body. */
const MAX_REQUEST_BYTES = MAX_BODY_BYTES + 64 * 1024;
/** Revisions kept per draft, `publish` ones aside (those are kept forever). */
export const REVISION_CAP = 50;

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTE = /^\/api\/admin\/drafts(?:\/([^/]+)(?:\/(revisions)(?:\/([^/]+)\/(restore))?)?)?$/;

/** Reasons a save may ask for a snapshot. `publish` and `restore` are written by the server. */
const SAVE_REASONS = new Set(["interval", "manual", "conflict"]);

/** The draft fields an editor sends; any subset on a save. */
export interface DraftFields {
  title?: string;
  summary?: string;
  category?: string | null;
  tags?: string[];
  bodyMd?: string;
}

interface DraftRow {
  id: string;
  kind: "new" | "edit";
  source_path: string | null;
  slug: string | null;
  title: string;
  summary: string;
  category: string | null;
  tags: string;
  cover_key: string | null;
  body_md: string;
  rev: number;
  status: string;
  pr_number: number | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

const DRAFT_COLUMNS =
  "id, kind, source_path, slug, title, summary, category, tags, cover_key, body_md, rev, status, " +
  "pr_number, created_at, updated_at, published_at";

/** A draft as the API returns it. */
function toDraft(row: DraftRow) {
  return {
    id: row.id,
    kind: row.kind,
    sourcePath: row.source_path,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    cover: row.cover_key,
    bodyMd: row.body_md,
    rev: row.rev,
    status: row.status,
    prNumber: row.pr_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/** Routes /api/admin/drafts and below. Returns null for any other path. */
export async function handleDrafts(request: Request, env: ImagesEnv): Promise<Response | null> {
  const match = ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, id, revisions, rev, restore] = match;
  const { method } = request;
  const db = env.DB;

  if (id === undefined) {
    if (method === "GET") return listDrafts(db);
    if (method === "POST") return createDraft(request, db);
    return methodNotAllowed("GET, POST");
  }
  if (!DRAFT_ID.test(id)) return draftNotFound();
  if (revisions === undefined) {
    if (method === "GET") return getDraft(db, id);
    if (method === "PUT") return saveDraft(request, db, id);
    if (method === "DELETE") return discardDraft(env, id);
    return methodNotAllowed("GET, PUT, DELETE");
  }
  if (restore === undefined) {
    if (method === "GET") return listRevisions(db, id);
    return methodNotAllowed("GET");
  }
  if (!/^[1-9][0-9]{0,8}$/.test(rev ?? "")) return revisionNotFound();
  if (method === "POST") return restoreRevision(request, db, id, Number(rev));
  return methodNotAllowed("POST");
}

const draftNotFound = () => jsonError(404, "not_found", "No such draft.");
const revisionNotFound = () => jsonError(404, "not_found", "No such revision.");
const noStore = { "Cache-Control": "no-store" };

async function listDrafts(db: D1Database): Promise<Response> {
  const { results } = await db
    .prepare(
      "SELECT id, kind, slug, title, summary, rev, status, updated_at FROM drafts " +
        "WHERE status != 'archived' ORDER BY updated_at DESC, id",
    )
    .all<
      Pick<DraftRow, "id" | "kind" | "slug" | "title" | "summary" | "rev" | "status"> & {
        updated_at: number;
      }
    >();
  const drafts = results.map((row) => ({
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    rev: row.rev,
    status: row.status,
    updatedAt: row.updated_at,
  }));
  return Response.json({ drafts }, { headers: noStore });
}

async function createDraft(request: Request, db: D1Database): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const fields = parseFields(body);
  if (fields instanceof Response) return fields;

  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO drafts (id, kind, title, summary, category, tags, body_md, rev, created_at, " +
        "updated_at) VALUES (?, 'new', ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(
      id,
      fields.title ?? "",
      fields.summary ?? "",
      fields.category ?? null,
      JSON.stringify(fields.tags ?? []),
      fields.bodyMd ?? "",
      now,
      now,
    )
    .run();
  return Response.json({ id, rev: 1 }, { status: 201, headers: noStore });
}

async function getDraft(db: D1Database, id: string): Promise<Response> {
  const row = await db
    .prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`)
    .bind(id)
    .first<DraftRow>();
  if (!row) return draftNotFound();
  return Response.json(toDraft(row), { headers: noStore });
}

/** The row as a revision of `rev`, if the row is still at that rev. */
function snapshot(db: D1Database, id: string, rev: number, reason: string, now: number) {
  return db
    .prepare(
      "INSERT INTO draft_revisions (draft_id, rev, title, body_md, meta, reason, created_at) " +
        "SELECT id, rev, title, body_md, json_object('summary', summary, 'category', category, " +
        "'tags', json(tags), 'cover', cover_key), ?, ? FROM drafts WHERE id = ? AND rev = ? " +
        "ON CONFLICT (draft_id, rev) DO NOTHING",
    )
    .bind(reason, now, id, rev);
}

/** Drops the oldest revisions past the cap, never a `publish` one, if the row is at `rev`. */
function prune(db: D1Database, id: string, rev: number) {
  return db
    .prepare(
      "DELETE FROM draft_revisions WHERE draft_id = ? AND reason != 'publish' " +
        "AND EXISTS (SELECT 1 FROM drafts WHERE id = ? AND rev = ?) " +
        "AND rev NOT IN (SELECT rev FROM draft_revisions WHERE draft_id = ? " +
        "AND reason != 'publish' ORDER BY rev DESC LIMIT ?)",
    )
    .bind(id, id, rev, id, REVISION_CAP);
}

/**
 * Keeps the saved version as a revision and prunes, as statements for one batch. Runs only after
 * this request's UPDATE succeeded, so a row at `rev` is this save's; if another save has moved it
 * on, both statements match nothing and the next snapshot catches up.
 */
function keepRevision(db: D1Database, id: string, rev: number, reason: string, now: number) {
  return [snapshot(db, id, rev, reason, now), prune(db, id, rev)];
}

/**
 * Marks the draft's images against its body at `rev`: a ready image the body no longer mentions
 * becomes an orphan, and an orphan it mentions again is ready. Like `keepRevision`, both match
 * nothing once another save has moved the row on, and that save marks against its own body. A
 * mention is the id anywhere in the body, so an image is kept rather than lost on a near miss.
 */
function markImages(db: D1Database, id: string, rev: number, now: number) {
  return [
    db
      .prepare(
        "UPDATE images SET state = 'orphan', orphaned_at = ? WHERE draft_id = ? " +
          "AND state = 'ready' AND EXISTS (SELECT 1 FROM drafts WHERE id = ? AND rev = ? " +
          "AND instr(body_md, images.id) = 0)",
      )
      .bind(now, id, id, rev),
    db
      .prepare(
        "UPDATE images SET state = 'ready', orphaned_at = NULL WHERE draft_id = ? " +
          "AND state = 'orphan' AND EXISTS (SELECT 1 FROM drafts WHERE id = ? AND rev = ? " +
          "AND instr(body_md, images.id) > 0)",
      )
      .bind(id, id, rev),
  ];
}

/**
 * Autosave: `{baseRev, ...fields, revision?}`. The UPDATE only matches while the row is still at
 * `baseRev`, so a save from a stale tab is a 409 and changes nothing. `revision: "conflict"` (the
 * editor's Overwrite) first keeps the version being overwritten; `interval` and `manual` keep the
 * saved one.
 */
async function saveDraft(request: Request, db: D1Database, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { baseRev, revision, ...rest } = body;
  if (!Number.isSafeInteger(baseRev) || (baseRev as number) < 1) {
    return jsonError(400, "bad_request", "baseRev must be a positive integer.");
  }
  if (revision !== undefined && !SAVE_REASONS.has(revision as string)) {
    return jsonError(400, "bad_request", "revision must be interval, manual or conflict.");
  }
  const fields = parseFields(rest);
  if (fields instanceof Response) return fields;

  const base = baseRev as number;
  const now = Date.now();
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (fields.title !== undefined) set("title", fields.title);
  if (fields.summary !== undefined) set("summary", fields.summary);
  if (fields.category !== undefined) set("category", fields.category);
  if (fields.tags !== undefined) set("tags", JSON.stringify(fields.tags));
  if (fields.bodyMd !== undefined) set("body_md", fields.bodyMd);
  set("updated_at", now);

  const update = db
    .prepare(
      `UPDATE drafts SET ${sets.join(", ")}, rev = rev + 1 WHERE id = ? AND rev = ? RETURNING rev`,
    )
    .bind(...values, id, base);
  // Overwrite keeps the version it replaces: the row while it is still at baseRev, in the same
  // batch as the UPDATE, so nothing can save in between.
  const results = await db.batch<{ rev: number }>(
    revision === "conflict" ? [snapshot(db, id, base, "conflict", now), update] : [update],
  );
  const updated = results.at(-1)?.results[0];
  if (updated) {
    const followUps: D1PreparedStatement[] = [];
    if (revision === "interval" || revision === "manual") {
      followUps.push(...keepRevision(db, id, updated.rev, revision, now));
    } else if (revision === "conflict") {
      followUps.push(prune(db, id, updated.rev));
    }
    if (followUps.length > 0) await db.batch(followUps);
    if (fields.bodyMd !== undefined) {
      try {
        await db.batch(markImages(db, id, updated.rev, now));
      } catch {
        // The save itself landed, and the next save with a body marks again.
        console.error("Marking a draft's images after a save failed.");
      }
    }
    return Response.json({ rev: updated.rev }, { headers: noStore });
  }
  return conflictOrMissing(db, id);
}

/** 409 with the current rev when the draft moved on, 404 when it is gone. */
async function conflictOrMissing(db: D1Database, id: string): Promise<Response> {
  const current = await db
    .prepare("SELECT rev, updated_at FROM drafts WHERE id = ?")
    .bind(id)
    .first<{ rev: number; updated_at: number }>();
  if (!current) return draftNotFound();
  return Response.json(
    {
      error: { code: "conflict", message: "The draft was saved somewhere else." },
      rev: current.rev,
      updatedAt: current.updated_at,
    },
    { status: 409, headers: noStore },
  );
}

/**
 * Discards a draft and its revisions. Not while a publish is open. Its unpublished images go too,
 * objects and rows, unless another draft or one of its revisions mentions them. Published images
 * stay: a committed post may show them.
 */
async function discardDraft(env: ImagesEnv, id: string): Promise<Response> {
  const db = env.DB;
  // The images are chosen in the same transaction as the delete, which sets their draft_id NULL.
  const [images, discarded] = await db.batch<StoredImage>([
    db
      .prepare(
        "SELECT id, ext, width FROM images WHERE draft_id = ? AND published = 0 " +
          "AND NOT EXISTS (SELECT 1 FROM drafts WHERE id != ? AND instr(body_md, images.id) > 0) " +
          "AND NOT EXISTS (SELECT 1 FROM draft_revisions WHERE draft_id != ? " +
          "AND instr(body_md, images.id) > 0)",
      )
      .bind(id, id, id),
    db.prepare("DELETE FROM drafts WHERE id = ? AND status != 'publishing' RETURNING id").bind(id),
  ]);
  if (discarded?.results.length) {
    try {
      await deleteImages(env, images?.results ?? []);
    } catch {
      // The draft is gone either way. Rows left without a draft go in the daily clean-up.
      console.error("Deleting a discarded draft's images failed; the daily clean-up retries.");
    }
    return new Response(null, { status: 204, headers: noStore });
  }
  const exists = await db.prepare("SELECT 1 AS found FROM drafts WHERE id = ?").bind(id).first();
  if (!exists) return draftNotFound();
  return jsonError(409, "publishing", "Cancel the open publish before discarding this draft.");
}

async function listRevisions(db: D1Database, id: string): Promise<Response> {
  const exists = await db.prepare("SELECT 1 AS found FROM drafts WHERE id = ?").bind(id).first();
  if (!exists) return draftNotFound();
  const { results } = await db
    .prepare(
      "SELECT rev, title, reason, created_at FROM draft_revisions WHERE draft_id = ? " +
        "ORDER BY rev DESC",
    )
    .bind(id)
    .all<{ rev: number; title: string; reason: string; created_at: number }>();
  const revisions = results.map((row) => ({
    rev: row.rev,
    title: row.title,
    reason: row.reason,
    createdAt: row.created_at,
  }));
  return Response.json({ revisions }, { headers: noStore });
}

/**
 * Restore: `{baseRev}`. Copies the revision into the draft as a new rev, and keeps that rev as a
 * `restore` revision. Stale `baseRev` is a 409, like a save.
 */
async function restoreRevision(
  request: Request,
  db: D1Database,
  id: string,
  rev: number,
): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { baseRev } = body;
  if (!Number.isSafeInteger(baseRev) || (baseRev as number) < 1) {
    return jsonError(400, "bad_request", "baseRev must be a positive integer.");
  }
  const base = baseRev as number;
  const now = Date.now();
  const updated = await db
    .prepare(
      "UPDATE drafts SET title = r.title, body_md = r.body_md, " +
        "summary = json_extract(r.meta, '$.summary'), " +
        "category = json_extract(r.meta, '$.category'), " +
        "tags = json(json_extract(r.meta, '$.tags')), " +
        "cover_key = json_extract(r.meta, '$.cover'), " +
        "updated_at = ?, rev = drafts.rev + 1 " +
        "FROM (SELECT title, body_md, meta FROM draft_revisions WHERE draft_id = ? AND rev = ?) " +
        "AS r WHERE drafts.id = ? AND drafts.rev = ? RETURNING rev",
    )
    .bind(now, id, rev, id, base)
    .first<{ rev: number }>();
  if (updated) {
    await db.batch([
      ...keepRevision(db, id, updated.rev, "restore", now),
      ...markImages(db, id, updated.rev, now),
    ]);
    return Response.json({ rev: updated.rev }, { headers: noStore });
  }

  const known = await db
    .prepare("SELECT 1 AS found FROM draft_revisions WHERE draft_id = ? AND rev = ?")
    .bind(id, rev)
    .first();
  if (!known) {
    const draft = await db.prepare("SELECT 1 AS found FROM drafts WHERE id = ?").bind(id).first();
    return draft ? revisionNotFound() : draftNotFound();
  }
  return conflictOrMissing(db, id);
}

/** The request body as a JSON object, or the error response. */
async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_REQUEST_BYTES) return tooLarge();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BYTES) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError(400, "bad_request", "The body isn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "bad_request", "The body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

const tooLarge = () =>
  jsonError(413, "too_large", `A draft body can be at most ${MAX_BODY_BYTES / 1024} KB.`);

/** Draft metadata is checked against the post frontmatter, except that it may still be empty. */
const draftMeta = postFrontmatter.pick({ title: true, summary: true, category: true, tags: true });

/**
 * The editable fields of a request body, checked: unknown keys are refused, empty strings are
 * allowed (a draft starts empty), anything else must pass `postFrontmatter`, and tags come back
 * normalised.
 */
export function parseFields(body: Record<string, unknown>): DraftFields | Response {
  const allowed = new Set(["title", "summary", "category", "tags", "bodyMd"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(", ")}.`);

  const { title, summary, category, tags, bodyMd } = body;
  for (const [name, value] of Object.entries({ title, summary, bodyMd })) {
    if (value !== undefined && typeof value !== "string") return invalid(`${name} must be text.`);
  }
  if (category !== undefined && category !== null && typeof category !== "string") {
    return invalid("category must be text or null.");
  }
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
    return invalid("tags must be a list of text.");
  }
  if (typeof bodyMd === "string" && new TextEncoder().encode(bodyMd).byteLength > MAX_BODY_BYTES) {
    return tooLarge();
  }

  const check = draftMeta.partial().safeParse({
    title: title || undefined,
    summary: summary || undefined,
    category: category || undefined,
    tags,
  });
  if (!check.success) {
    const issue = check.error.issues[0];
    return invalid(`${issue?.path.join(".") || "draft"}: ${issue?.message ?? "invalid"}.`);
  }
  const fields: DraftFields = {};
  if (title !== undefined) fields.title = title as string;
  if (summary !== undefined) fields.summary = summary as string;
  if (category !== undefined) fields.category = (category as string | null) || null;
  if (tags !== undefined) fields.tags = [...new Set(check.data.tags)];
  if (bodyMd !== undefined) fields.bodyMd = bodyMd as string;
  return fields;
}

const invalid = (message: string) => jsonError(422, "invalid_draft", message);
