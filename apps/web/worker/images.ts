import {
  FIGURE_SRC,
  MAX_FIGURE_WIDTH,
  figureWidths,
  variantKey,
} from "@site/content-markdown/figure";
import { jsonError, methodNotAllowed } from "./api";

// Image uploads to R2 (design doc §4.9.6, execution plan Step 10.6). The admin router mounts this
// behind the owner gate, so nothing here checks access. The browser re-encodes images before
// upload, which drops EXIF and GPS. The Worker doesn't trust that: it sniffs every file and
// refuses one that carries metadata, so a client bug can't publish a location. Only figure.ts is
// imported from content-markdown, because the package index pulls in Shiki and remark.

/** The largest file one upload may store. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** The tallest image a client may announce. Widths are capped by `MAX_FIGURE_WIDTH`. */
const MAX_IMAGE_HEIGHT = 16384;
/** The most figure keys one request may mark as published. */
const MAX_PUBLISHED_SRCS = 200;
/** The largest JSON request; 200 figure keys fit easily. */
const MAX_JSON_BYTES = 32 * 1024;
/** Keys per R2 delete call, the API's limit. */
const MAX_DELETE_KEYS = 1000;
/** Images deleted per clean-up run; anything left over goes the next day. */
const CLEAN_UP_LIMIT = 500;

const DAY = 24 * 60 * 60 * 1000;
/** How long an unused image is kept before the clean-up deletes it. */
const PENDING_TTL = DAY;
const ORPHAN_TTL = 7 * DAY;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTE = /^\/api\/admin\/images(?:\/(published)|\/([^/]+)\/([^/]+))?$/;

/** The stored image types, as the `ext` of a figure key. */
export type ImageExt = "webp" | "jpg" | "png" | "gif";

const MEDIA_TYPES: Record<ImageExt, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};
const TYPE_NAMES: Record<ImageExt, string> = {
  webp: "a WebP",
  jpg: "a JPEG",
  png: "a PNG",
  gif: "a GIF",
};

/** The bindings this module uses. */
export type ImagesEnv = Pick<Env, "DB" | "PHOTOS">;

/** An image row, with enough to name every R2 key it may have. */
export interface StoredImage {
  id: string;
  ext: string;
  width: number;
}

const noStore = { "Cache-Control": "no-store" };
const imageNotFound = () => jsonError(404, "not_found", "No such image.");
const invalid = (message: string) => jsonError(422, "invalid_image", message);
const unsupported = (message: string) => jsonError(415, "unsupported_type", message);
const tooLarge = () =>
  jsonError(413, "too_large", `An image can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);

/** Routes /api/admin/images and below. Returns null for any other path. */
export async function handleImages(request: Request, env: ImagesEnv): Promise<Response | null> {
  const match = ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, published, id, width] = match;
  const { method } = request;

  if (published !== undefined) {
    return method === "POST" ? markPublished(request, env.DB) : methodNotAllowed("POST");
  }
  if (id === undefined) {
    return method === "POST" ? createImage(request, env.DB) : methodNotAllowed("POST");
  }
  if (!UUID.test(id) || !/^[1-9][0-9]{0,4}$/.test(width ?? "")) return imageNotFound();
  if (method !== "PUT") return methodNotAllowed("PUT");
  return uploadVariant(request, env, id, Number(width));
}

const isExt = (value: unknown): value is ImageExt =>
  typeof value === "string" && Object.hasOwn(MEDIA_TYPES, value);

const isDimension = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

/**
 * `{draftId, ext, width, height}`, the largest variant's size: writes a `pending` row with a
 * server-made id and returns the figure key and the widths to upload.
 */
async function createImage(request: Request, db: D1Database): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["draftId", "ext", "width", "height"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(", ")}.`);

  const { draftId, ext, width, height } = body;
  if (typeof draftId !== "string" || !UUID.test(draftId)) return invalid("draftId must be an id.");
  if (!isExt(ext)) return invalid("ext must be webp, jpg, png or gif.");
  if (!isDimension(width, MAX_FIGURE_WIDTH)) {
    return invalid(`width must be a whole number from 1 to ${MAX_FIGURE_WIDTH}.`);
  }
  if (!isDimension(height, MAX_IMAGE_HEIGHT)) {
    return invalid(`height must be a whole number from 1 to ${MAX_IMAGE_HEIGHT}.`);
  }

  const id = crypto.randomUUID();
  const created = await db
    .prepare(
      "INSERT INTO images (id, draft_id, ext, width, height, bytes, state, created_at) " +
        "SELECT ?, id, ?, ?, ?, 0, 'pending', ? FROM drafts WHERE id = ?",
    )
    .bind(id, ext, width, height, Date.now(), draftId)
    .run();
  if (created.meta.changes === 0) return jsonError(404, "not_found", "No such draft.");
  const src = `blog/${id}.${ext}`;
  return Response.json(
    { id, src, widths: figureWidths(src, width) },
    { status: 201, headers: noStore },
  );
}

/**
 * Raw bytes of one variant. The file must be the type the row was created with and carry no
 * metadata. It is stored under its variant key with immutable caching, the row records the width,
 * and the row turns `ready` once every width is stored. Putting a width again replaces the same
 * key, until the image is published.
 */
async function uploadVariant(
  request: Request,
  env: ImagesEnv,
  id: string,
  width: number,
): Promise<Response> {
  const length = request.headers.get("Content-Length");
  if (length === null || !/^[0-9]+$/.test(length)) {
    return jsonError(411, "length_required", "Send the image with a Content-Length.");
  }
  if (Number(length) > MAX_IMAGE_BYTES) return tooLarge();

  const row = await env.DB.prepare(
    "SELECT ext, width, published, draft_id FROM images WHERE id = ?",
  )
    .bind(id)
    .first<{ ext: ImageExt; width: number; published: number; draft_id: string | null }>();
  // An image whose draft was discarded takes no more uploads.
  if (!row || row.draft_id === null) return imageNotFound();
  const src = `blog/${id}.${row.ext}`;
  const widths = figureWidths(src, row.width);
  if (!widths.includes(width)) {
    return invalid(`This image is stored at ${widths.join(", ")} px wide, not ${width}.`);
  }
  if (row.published) {
    return jsonError(409, "published", "This image is published, so it can't be replaced.");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) return tooLarge();
  const type = sniffImage(bytes);
  if (type === null) return unsupported("Only JPEG, PNG, WebP and GIF images can be uploaded.");
  if (type !== row.ext) {
    return unsupported(
      `The file is ${TYPE_NAMES[type]}, but this image is ${TYPE_NAMES[row.ext]}.`,
    );
  }
  const scan = scanImage(bytes, type);
  if (scan === "metadata") {
    return jsonError(
      415,
      "image_metadata",
      "The file carries metadata such as EXIF or XMP, which can include a location.",
    );
  }
  if (scan === "malformed") return unsupported(`The file isn't a complete ${TYPE_NAMES[type]}.`);

  const key = variantKey(src, width);
  await env.PHOTOS.put(key, bytes, {
    httpMetadata: {
      contentType: MEDIA_TYPES[type],
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: "inline",
    },
  });

  // In one batch, so concurrent PUTs of other widths can't lose each other's width. The bytes
  // count a width once, however often it is put. The CASTs keep widths integers: a number may be
  // bound as a REAL, which json_group_array would write as 480.0.
  const results = await env.DB.batch<{ state: string }>([
    env.DB.prepare(
      "UPDATE images SET " +
        "bytes = coalesce(bytes, 0) + CASE WHEN EXISTS " +
        "(SELECT 1 FROM json_each(images.widths) WHERE value = CAST(? AS INTEGER)) " +
        "THEN 0 ELSE ? END, " +
        "widths = (SELECT json_group_array(value) FROM (SELECT value FROM " +
        "json_each(images.widths) UNION SELECT CAST(? AS INTEGER) ORDER BY 1)) WHERE id = ?",
    ).bind(width, bytes.byteLength, width, id),
    env.DB.prepare(
      "UPDATE images SET state = 'ready' WHERE id = ? AND state = 'pending' " +
        "AND draft_id IS NOT NULL AND NOT EXISTS " +
        "(SELECT 1 FROM json_each(?) AS needed WHERE needed.value NOT IN " +
        "(SELECT value FROM json_each(images.widths)))",
    ).bind(id, JSON.stringify(widths)),
    env.DB.prepare("SELECT state, draft_id FROM images WHERE id = ?").bind(id),
  ]);
  const current = results.at(-1)?.results[0] as
    { state: string; draft_id: string | null } | undefined;
  // The draft was discarded while the bytes were on their way. Its discard may already have
  // deleted this image's objects, so this one would be left behind with nothing pointing at it.
  // A pending image is in no body yet, so its object can go.
  if (!current || (current.draft_id === null && current.state === "pending")) {
    await env.PHOTOS.delete(key);
    return imageNotFound();
  }
  return Response.json({ state: current.state }, { headers: noStore });
}

/**
 * `{srcs}`: marks those figure keys published, because the Markdown that uses them may now be
 * committed (Download .md and Copy as Markdown). A published image is never deleted automatically.
 * An orphan becomes ready again; a pending upload isn't marked.
 */
async function markPublished(request: Request, db: D1Database): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "srcs");
  if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(", ")}.`);
  const { srcs } = body;
  if (
    !Array.isArray(srcs) ||
    srcs.length > MAX_PUBLISHED_SRCS ||
    !srcs.every((src) => typeof src === "string" && FIGURE_SRC.test(src))
  ) {
    return invalid(`srcs must be at most ${MAX_PUBLISHED_SRCS} figure keys like blog/<id>.webp.`);
  }
  if (srcs.length === 0) return Response.json({ published: 0 }, { headers: noStore });

  const keys = JSON.stringify([...new Set(srcs)]);
  const result = await db
    .prepare(
      "UPDATE images SET published = 1, state = 'ready', orphaned_at = NULL " +
        "WHERE state IN ('ready', 'orphan') " +
        "AND id IN (SELECT substr(value, 6, 36) FROM json_each(?)) " +
        "AND 'blog/' || id || '.' || ext IN (SELECT value FROM json_each(?))",
    )
    .bind(keys, keys)
    .run();
  return Response.json({ published: result.meta.changes }, { headers: noStore });
}

/**
 * The daily clean-up, run by `scheduled()` in index.ts. Deletes the objects and rows of abandoned
 * images: uploads still `pending` after a day, orphans unused for 7 days, uploads never put in the
 * post (the dialog was cancelled) after 7 days, and images whose draft was discarded, after a day.
 * An image that any draft or revision still mentions is kept, and a published one is never
 * deleted. Returns how many images went.
 */
export async function cleanUpImages(env: ImagesEnv, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, ext, width FROM images WHERE published = 0 AND (" +
      "(state = 'pending' AND created_at < ?) OR (state = 'orphan' AND orphaned_at < ?) OR " +
      "(state = 'ready' AND created_at < ?) OR (draft_id IS NULL AND created_at < ?)) " +
      "AND NOT EXISTS (SELECT 1 FROM drafts WHERE instr(body_md, images.id) > 0) " +
      "AND NOT EXISTS (SELECT 1 FROM draft_revisions WHERE instr(body_md, images.id) > 0) " +
      "LIMIT ?",
  )
    .bind(now - PENDING_TTL, now - ORPHAN_TTL, now - ORPHAN_TTL, now - PENDING_TTL, CLEAN_UP_LIMIT)
    .all<StoredImage>();
  return deleteImages(env, results);
}

/**
 * Deletes unpublished images: every key each one may have (all of its widths, stored or not),
 * then the rows. Objects go first, so a failed delete leaves the row for the clean-up to retry.
 * Returns how many rows went.
 */
export async function deleteImages(env: ImagesEnv, images: StoredImage[]): Promise<number> {
  if (images.length === 0) return 0;
  const keys = images.flatMap(({ id, ext, width }) => {
    const src = `blog/${id}.${ext}`;
    return figureWidths(src, width).map((w) => variantKey(src, w));
  });
  for (let start = 0; start < keys.length; start += MAX_DELETE_KEYS) {
    await env.PHOTOS.delete(keys.slice(start, start + MAX_DELETE_KEYS));
  }
  const deleted = await env.DB.prepare(
    "DELETE FROM images WHERE published = 0 AND id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(images.map((image) => image.id)))
    .run();
  return deleted.meta.changes;
}

/** The request body as a small JSON object, or the error response. */
async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const tooLong = () => jsonError(413, "too_large", "The request is too large.");
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_JSON_BYTES) return tooLong();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BYTES) return tooLong();
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

// ---- Sniffing and the metadata check ----
// Only headers and block structure are read; nothing is decoded, so this stays well inside the
// Worker's CPU limit even for a 10 MB file.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** The image type from a file's first bytes, whatever its name or Content-Type claims. */
export function sniffImage(bytes: Uint8Array): ImageExt | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "png";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
}

/** What the metadata check found: nothing, metadata, or a file whose structure doesn't hold. */
export type ImageScan = "clean" | "metadata" | "malformed";

/** Walks a file of the sniffed type and reports metadata blocks or a broken structure. */
export function scanImage(bytes: Uint8Array, type: ImageExt): ImageScan {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "jpg") return scanJpeg(bytes);
  if (type === "png") return scanPng(bytes, view);
  if (type === "webp") return scanWebp(bytes, view);
  return scanGif(bytes);
}

/**
 * JPEG: walks the marker segments from SOI to EOI, skipping the entropy-coded data after each
 * SOS, so a later scan of a progressive file is checked too. APP1 holds EXIF (with GPS) and XMP;
 * APP13 holds Photoshop's IPTC block, which can name a place. Both are refused.
 */
function scanJpeg(bytes: Uint8Array): ImageScan {
  let at = 2;
  for (;;) {
    if (bytes[at] !== 0xff) return "malformed";
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8) return "malformed";
    if (marker === 0xd9) return "clean";
    // TEM and the restart markers have no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return "malformed";
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2 || at + length > bytes.length) return "malformed";
    if (marker === 0xe1 || marker === 0xed) return "metadata";
    at += length;
    if (marker === 0xda) {
      at = skipEntropyData(bytes, at);
      if (at < 0) return "malformed";
    }
  }
}

/** The offset of the next marker after entropy-coded data, or -1 when the file ends first. */
function skipEntropyData(bytes: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    at = bytes.indexOf(0xff, at);
    if (at < 0 || at + 1 >= bytes.length) return -1;
    const next = bytes[at + 1]!;
    // A stuffed zero byte or a restart marker is part of the data; 0xFF fill precedes a marker.
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
    else if (next === 0xff) at += 1;
    else return at;
  }
}

/**
 * PNG: walks the chunks from IHDR to IEND. `eXIf` is EXIF; a text chunk keyed
 * `XML:com.adobe.xmp` is XMP, and `Raw profile type …` is how ImageMagick keeps EXIF, XMP or
 * IPTC. CRCs aren't checked.
 */
function scanPng(bytes: Uint8Array, view: DataView): ImageScan {
  let at = PNG_SIGNATURE.length;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    const data = at + 8;
    const end = data + length + 4;
    if (end > bytes.length) return "malformed";
    if (at === PNG_SIGNATURE.length && type !== "IHDR") return "malformed";
    if (type === "IEND") return "clean";
    if (type === "eXIf") return "metadata";
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const field = bytes.subarray(data, data + Math.min(length, 80));
      const nul = field.indexOf(0);
      const keyword = ascii(field, 0, nul < 0 ? field.length : nul);
      if (keyword === "XML:com.adobe.xmp" || keyword.startsWith("Raw profile type")) {
        return "metadata";
      }
    }
    at = end;
  }
  return "malformed";
}

/**
 * WebP: walks the RIFF chunks. `EXIF` and `XMP ` chunks are metadata, and so are the VP8X flags
 * that announce them (EXIF 0x08, XMP 0x04), even without the chunk.
 */
function scanWebp(bytes: Uint8Array, view: DataView): ImageScan {
  const end = 8 + view.getUint32(4, true);
  if (end > bytes.length) return "malformed";
  let at = 12;
  let chunks = 0;
  while (at + 8 <= end) {
    const type = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const data = at + 8;
    if (data + size > end) return "malformed";
    if (chunks++ === 0 && type !== "VP8 " && type !== "VP8L" && type !== "VP8X") {
      return "malformed";
    }
    if (type === "EXIF" || type === "XMP ") return "metadata";
    if (type === "VP8X") {
      if (size < 10) return "malformed";
      if ((bytes[data]! & 0x0c) !== 0) return "metadata";
    }
    // Chunks are padded to an even size.
    at = data + size + (size & 1);
  }
  return chunks > 0 && at >= end ? "clean" : "malformed";
}

/**
 * Application extensions a GIF may carry: looping (`NETSCAPE2.0`, `ANIMEXTS1.0`), a colour profile
 * and ImageMagick's gamma note. Any other is refused: `XMP DataXMP` is XMP, and ImageMagick keeps
 * Photoshop and IPTC blocks (which can hold EXIF or name a place) as `MGK8BIM0000` and
 * `MGKIPTC0000`.
 */
const GIF_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012", "ImageMagick"]);

/** GIF: walks the blocks after the screen descriptor to the trailer. */
function scanGif(bytes: Uint8Array): ImageScan {
  let at = 13;
  const screen = bytes[10];
  if (screen === undefined) return "malformed";
  if (screen & 0x80) at += 3 << ((screen & 0x07) + 1);
  for (;;) {
    const block = bytes[at++];
    if (block === 0x3b) return "clean";
    if (block === 0x21) {
      const label = bytes[at++];
      if (label === undefined) return "malformed";
      if (label === 0xff) {
        if (bytes[at] !== 11 || at + 12 > bytes.length) return "malformed";
        if (!GIF_APPLICATIONS.has(ascii(bytes, at + 1, 11))) return "metadata";
      }
      at = skipSubBlocks(bytes, at);
    } else if (block === 0x2c) {
      const image = bytes[at + 8];
      if (image === undefined) return "malformed";
      at += 9;
      if (image & 0x80) at += 3 << ((image & 0x07) + 1);
      // The LZW minimum code size, then the image data.
      at = skipSubBlocks(bytes, at + 1);
    } else {
      return "malformed";
    }
    if (at < 0) return "malformed";
  }
}

/** Skips GIF data sub-blocks through the empty one that ends them; -1 if the file ends first. */
function skipSubBlocks(bytes: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    const size = bytes[at];
    if (size === undefined) return -1;
    at += size + 1;
    if (size === 0) return at;
  }
}
