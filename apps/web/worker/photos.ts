import { MAX_FIGURE_WIDTH } from "@site/content-markdown/figure";
import {
  MAX_ALT_LENGTH,
  MAX_CAPTION_LENGTH,
  cleanText,
  photoKey,
  photoWidths,
  type Photo,
} from "../app/lib/photos";
import { PHOTO_COLUMNS, listPhotos, toPhoto, type PhotoRow } from "../app/lib/photos.server";
import { jsonError, methodNotAllowed } from "./api";
import {
  MAX_IMAGE_HEIGHT,
  checkUploadLength,
  isDimension,
  putImageObject,
  readImageUpload,
  readJson,
} from "./images";

// The Photos page's uploads (execution plan Phase 5, built as uploads from /admin so they work
// from a phone). The admin router mounts this behind the owner gate, so nothing here checks
// access. Uploads follow the editor's image rules (images.ts): the browser re-encodes, and the
// Worker sniffs every file and refuses one that carries metadata. A photo shows on /photos as soon
// as every variant is stored; there is no review step.

/** The bindings this module uses. */
export type PhotosEnv = Pick<Env, "DB" | "PHOTOS">;

const DAY = 24 * 60 * 60 * 1000;
/** Photos whose upload never finished are deleted after this long. */
const PENDING_TTL = DAY;
/** Photos deleted per clean-up run; anything left over goes the next day. */
const CLEAN_UP_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTE = /^\/api\/admin\/photos(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const EXTS = new Set(["webp", "jpg", "gif"]);

const noStore = { "Cache-Control": "no-store" };
const photoNotFound = () => jsonError(404, "not_found", "No such photo.");
const invalid = (message: string) => jsonError(422, "invalid_photo", message);

/** Routes /api/admin/photos and below. Returns null for any other path. */
export async function handlePhotos(request: Request, env: PhotosEnv): Promise<Response | null> {
  const match = ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, id, width] = match;
  const { method } = request;

  if (id === undefined) {
    if (method === "GET")
      return Response.json({ photos: await listPhotos(env.DB) }, { headers: noStore });
    if (method === "POST") return createPhoto(request, env.DB);
    return methodNotAllowed("GET, POST");
  }
  if (!UUID.test(id)) return photoNotFound();
  if (width === undefined) {
    if (method === "PATCH") return updatePhoto(request, env.DB, id);
    if (method === "DELETE") return deletePhoto(env, id);
    return methodNotAllowed("PATCH, DELETE");
  }
  if (!/^[1-9][0-9]{0,4}$/.test(width)) return photoNotFound();
  if (method !== "PUT") return methodNotAllowed("PUT");
  return uploadVariant(request, env, id, Number(width));
}

/** A caption or alt field: absent, or a string no longer than `max` once cleaned. */
function textField(
  body: Record<string, unknown>,
  name: "caption" | "alt",
  max: number,
): string | undefined | Response {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid(`${name} must be text.`);
  const text = cleanText(value);
  if (text.length > max) return invalid(`${name} can be at most ${max} characters.`);
  return text;
}

/**
 * `{ext, width, height, caption?, alt?}`, the largest variant's size: writes a `pending` row with a
 * server-made id and returns it with the widths to upload.
 */
async function createPhoto(request: Request, db: D1Database): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["ext", "width", "height", "caption", "alt"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(", ")}.`);

  const { ext, width, height } = body;
  if (typeof ext !== "string" || !EXTS.has(ext)) return invalid("ext must be webp, jpg or gif.");
  if (!isDimension(width, MAX_FIGURE_WIDTH)) {
    return invalid(`width must be a whole number from 1 to ${MAX_FIGURE_WIDTH}.`);
  }
  if (!isDimension(height, MAX_IMAGE_HEIGHT)) {
    return invalid(`height must be a whole number from 1 to ${MAX_IMAGE_HEIGHT}.`);
  }
  const caption = textField(body, "caption", MAX_CAPTION_LENGTH);
  if (caption instanceof Response) return caption;
  const alt = textField(body, "alt", MAX_ALT_LENGTH);
  if (alt instanceof Response) return alt;

  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO photos (id, ext, width, height, caption, alt, state, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(id, ext, width, height, caption ?? "", alt ?? "", now, now)
    .run();
  const widths = photoWidths({ id, ext: ext as Photo["ext"], width });
  return Response.json({ id, widths }, { status: 201, headers: noStore });
}

/**
 * Raw bytes of one variant, checked like an editor image. The photo turns `ready`, and so shows on
 * /photos, once every width is stored.
 */
async function uploadVariant(
  request: Request,
  env: PhotosEnv,
  id: string,
  width: number,
): Promise<Response> {
  const refused = checkUploadLength(request);
  if (refused) return refused;

  const row = await env.DB.prepare("SELECT ext, width, state FROM photos WHERE id = ?")
    .bind(id)
    .first<{ ext: Photo["ext"]; width: number; state: string }>();
  if (!row) return photoNotFound();
  const widths = photoWidths({ id, ext: row.ext, width: row.width });
  if (!widths.includes(width)) {
    return invalid(`This photo is stored at ${widths.join(", ")} px wide, not ${width}.`);
  }
  // Its files are cached for a year, so a replacement wouldn't reach everyone.
  if (row.state === "ready") {
    return jsonError(
      409,
      "published",
      "This photo is on the Photos page, so it can't be replaced.",
    );
  }

  const bytes = await readImageUpload(request, row.ext);
  if (bytes instanceof Response) return bytes;
  const key = photoKey({ id, ext: row.ext }, width);
  await putImageObject(env.PHOTOS, key, bytes, row.ext);

  // In one batch, so concurrent PUTs of other widths can't lose each other's width. The CASTs keep
  // widths integers (see images.ts).
  const results = await env.DB.batch<{ state: string }>([
    env.DB.prepare(
      "UPDATE photos SET " +
        "bytes = bytes + CASE WHEN EXISTS " +
        "(SELECT 1 FROM json_each(photos.widths) WHERE value = CAST(? AS INTEGER)) " +
        "THEN 0 ELSE ? END, " +
        "widths = (SELECT json_group_array(value) FROM (SELECT value FROM " +
        "json_each(photos.widths) UNION SELECT CAST(? AS INTEGER) ORDER BY 1)) WHERE id = ?",
    ).bind(width, bytes.byteLength, width, id),
    env.DB.prepare(
      "UPDATE photos SET state = 'ready' WHERE id = ? AND state = 'pending' AND NOT EXISTS " +
        "(SELECT 1 FROM json_each(?) AS needed WHERE needed.value NOT IN " +
        "(SELECT value FROM json_each(photos.widths)))",
    ).bind(id, JSON.stringify(widths)),
    env.DB.prepare("SELECT state FROM photos WHERE id = ?").bind(id),
  ]);
  const current = results.at(-1)?.results[0] as { state: string } | undefined;
  // The photo was deleted while the bytes were on their way; its delete may already have run.
  if (!current) {
    await env.PHOTOS.delete(key);
    return photoNotFound();
  }
  return Response.json({ state: current.state }, { headers: noStore });
}

/** `{caption?, alt?}`: changes a photo's text. Returns the photo. */
async function updatePhoto(request: Request, db: D1Database, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "caption" && key !== "alt");
  if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(", ")}.`);
  const caption = textField(body, "caption", MAX_CAPTION_LENGTH);
  if (caption instanceof Response) return caption;
  const alt = textField(body, "alt", MAX_ALT_LENGTH);
  if (alt instanceof Response) return alt;

  const row = await db
    .prepare(
      "UPDATE photos SET caption = coalesce(?, caption), alt = coalesce(?, alt), updated_at = ? " +
        `WHERE id = ? RETURNING ${PHOTO_COLUMNS}`,
    )
    .bind(caption ?? null, alt ?? null, Date.now(), id)
    .first<PhotoRow>();
  if (!row) return photoNotFound();
  return Response.json(toPhoto(row), { headers: noStore });
}

/** Deletes a photo's objects, then its row. */
async function deletePhoto(env: PhotosEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, ext, width FROM photos WHERE id = ?")
    .bind(id)
    .first<{ id: string; ext: Photo["ext"]; width: number }>();
  if (!row) return photoNotFound();
  await deletePhotos(env, [row]);
  return new Response(null, { status: 204, headers: noStore });
}

/**
 * Deletes photos: every key each one may have (all of its widths, stored or not), then the rows.
 * Objects go first, so a failed delete leaves the row for a retry. A deleted object can stay in
 * the edge cache for up to a year unless purged by URL. Returns how many rows went.
 */
async function deletePhotos(
  env: PhotosEnv,
  photos: { id: string; ext: Photo["ext"]; width: number }[],
): Promise<number> {
  if (photos.length === 0) return 0;
  const keys = photos.flatMap((photo) => photoWidths(photo).map((w) => photoKey(photo, w)));
  // Each photo has at most three keys, so CLEAN_UP_LIMIT photos stay under R2's 1000 per call.
  await env.PHOTOS.delete(keys);
  const deleted = await env.DB.prepare(
    "DELETE FROM photos WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(photos.map((photo) => photo.id)))
    .run();
  return deleted.meta.changes;
}

/**
 * Part of the daily clean-up (`scheduled()` in index.ts): deletes photos whose upload never
 * finished after a day. Returns how many went.
 */
export async function cleanUpPhotos(env: PhotosEnv, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, ext, width FROM photos WHERE state = 'pending' AND created_at < ? LIMIT ?",
  )
    .bind(now - PENDING_TTL, CLEAN_UP_LIMIT)
    .all<{ id: string; ext: Photo["ext"]; width: number }>();
  return deletePhotos(env, results);
}
