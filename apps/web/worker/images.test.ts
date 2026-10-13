import { figureWidths, variantKey } from "@site/content-markdown/figure";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1 } from "./d1-fake";
import { handleDrafts } from "./drafts";
import { MAX_IMAGE_BYTES, cleanUpImages, handleImages, sniffImage } from "./images";
import { createR2, type StoredObject } from "./r2-fake";

// The image API against a real SQLite database with the shipped migrations (d1-fake.ts) and an
// in-memory R2 bucket (r2-fake.ts). The files are built byte by byte below: the Worker only reads
// headers and block structure, so none of them needs to decode.

const SITE = "https://ry-mart.com";
const DAY = 24 * 60 * 60 * 1000;
let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let photos: R2Bucket;
let objects: Map<string, StoredObject>;
let draftId: string;

beforeEach(async () => {
  ({ db, sqlite } = await createD1());
  ({ bucket: photos, objects } = createR2());
  draftId = addDraft();
});

function addDraft(bodyMd = "") {
  const id = crypto.randomUUID();
  sqlite
    .prepare(
      "INSERT INTO drafts (id, kind, body_md, created_at, updated_at) VALUES (?, 'new', ?, 0, 0)",
    )
    .run(id, bodyMd);
  return id;
}

const env = () => ({ DB: db, PHOTOS: photos });

async function send(request: Request) {
  const response = await handleImages(request, env());
  if (!response) throw new Error(`no route for ${request.method} ${request.url}`);
  const text = await response.text();
  return { status: response.status, response, json: text ? JSON.parse(text) : undefined };
}

const call = (method: string, path: string, body?: unknown) =>
  send(
    new Request(`${SITE}/api/admin/images${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** Uploads `bytes` as one variant, with a Content-Length unless `headers` says otherwise. */
const put = (
  id: string,
  width: number,
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = { "Content-Type": "image/webp" },
) =>
  send(
    new Request(`${SITE}/api/admin/images/${id}/${width}`, {
      method: "PUT",
      headers: { "Content-Length": String(bytes.byteLength), ...headers },
      body: bytes,
    }),
  );

async function createImage(ext = "webp", width = 300, height = 200) {
  const { status, json } = await call("POST", "", { draftId, ext, width, height });
  expect(status).toBe(201);
  return json as { id: string; src: string; widths: number[] };
}

const row = (id: string) =>
  sqlite
    .prepare("SELECT state, widths, bytes, published, orphaned_at FROM images WHERE id = ?")
    .all(id)[0];

// ---- Byte fixtures ----

const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());
const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
const u16be = (n: number) => [n >> 8, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32le = (n: number) => u32be(n).reverse();

// JPEG: marker segments, then a scan whose data has a stuffed 0xFF00 and a restart marker.
const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  ...u16be(payload.length + 2),
  ...payload,
];
const JFIF = segment(0xe0, [...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const ICC = segment(0xe2, [...text("ICC_PROFILE"), 0, 1, 1, ...Array<number>(16).fill(0)]);
const TABLES = [
  ...segment(0xdb, [0, ...Array<number>(64).fill(1)]),
  ...segment(0xc4, [0, ...Array<number>(16).fill(0)]),
];
const frame = (marker = 0xc0) => segment(marker, [8, ...u16be(200), ...u16be(300), 1, 1, 0x11, 0]);
const SCAN = [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
const jpegOf = (...parts: number[][]) => bytes([0xff, 0xd8], ...parts, [0xff, 0xd9]);
const jpeg = (...extra: number[][]) => jpegOf(JFIF, ...extra, TABLES, frame(), SCAN);

/** The APP1 a phone camera writes: EXIF whose GPS IFD holds a position. */
function exifWithGps(): number[] {
  const rational = (n: number, d: number) => [...u32be(n), ...u32be(d)];
  const entry = (tag: number, type: number, count: number, value: number[]) => [
    ...u16be(tag),
    ...u16be(type),
    ...u32be(count),
    ...value,
  ];
  const tiff = [
    ...text("MM"),
    ...u16be(42),
    ...u32be(8),
    // IFD0 at 8: just the GPS IFD pointer.
    ...u16be(1),
    ...entry(0x8825, 4, 1, u32be(26)),
    ...u32be(0),
    // The GPS IFD at 26: N 40° 26′ 46.2″, W 79° 58′ 55.8″, the rationals at 80 and 104.
    ...u16be(4),
    ...entry(1, 2, 2, [...text("N"), 0, 0, 0]),
    ...entry(2, 5, 3, u32be(80)),
    ...entry(3, 2, 2, [...text("W"), 0, 0, 0]),
    ...entry(4, 5, 3, u32be(104)),
    ...u32be(0),
    ...rational(40, 1),
    ...rational(26, 1),
    ...rational(462, 10),
    ...rational(79, 1),
    ...rational(58, 1),
    ...rational(558, 10),
  ];
  return segment(0xe1, [...text("Exif"), 0, 0, ...tiff]);
}
const XMP = text("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>");
const JPEG_XMP = segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/"), 0, ...XMP]);
const JPEG_IPTC = segment(0xed, [...text("Photoshop 3.0"), 0, ...text("8BIM"), 4, 4, 0, 0]);

// PNG: chunks after the signature. CRCs are zero; the Worker doesn't check them.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunk = (type: string, data: number[]) => [
  ...u32be(data.length),
  ...text(type),
  ...data,
  0,
  0,
  0,
  0,
];
const IHDR = chunk("IHDR", [...u32be(300), ...u32be(200), 8, 6, 0, 0, 0]);
const png = (...extra: number[][]) =>
  bytes(PNG_SIGNATURE, IHDR, ...extra, chunk("IDAT", [0x78, 0x9c, 1, 2, 3]), chunk("IEND", []));

// WebP: RIFF chunks, padded to an even size.
const riff = (type: string, data: number[]) => [
  ...text(type),
  ...u32le(data.length),
  ...data,
  ...(data.length % 2 ? [0] : []),
];
const VP8L = riff("VP8L", [0x2f, 0x2b, 0xc0, 0x31, 0x00]);
const vp8x = (flags: number) => riff("VP8X", [flags, 0, 0, 0, ...u24le(299), ...u24le(199)]);
const webpOf = (...chunks: number[][]) => {
  const body = [...text("WEBP"), ...chunks.flat()];
  return bytes(text("RIFF"), u32le(body.length), body);
};
const webp = () => webpOf(VP8L);

// GIF: a two-colour global table, then blocks up to the trailer.
const gifOf = (version: string, ...blocks: number[][]) =>
  bytes(
    text(version),
    u16le(300),
    u16le(200),
    [0x80, 0, 0, 0, 0, 0, 255, 255, 255],
    ...blocks,
    [0x3b],
  );
const GIF_IMAGE = [
  0x2c,
  ...u16le(0),
  ...u16le(0),
  ...u16le(300),
  ...u16le(200),
  0,
  2,
  2,
  0x4c,
  1,
  0,
];
const NETSCAPE = [0x21, 0xff, 11, ...text("NETSCAPE2.0"), 3, 1, 0, 0, 0];
const COMMENT = [0x21, 0xfe, 5, ...text("hello"), 0];
// XMP is stored raw, followed by the 257-byte "magic trailer" that lets readers skip it.
const GIF_XMP = [
  ...[0x21, 0xff, 11, ...text("XMP DataXMP")],
  ...XMP,
  1,
  ...Array.from({ length: 256 }, (_, i) => 255 - i),
  0,
];
// ImageMagick keeps a Photoshop block (which can hold EXIF or IPTC) as an application extension.
const GIF_8BIM = [0x21, 0xff, 11, ...text("MGK8BIM0000"), 4, ...text("8BIM"), 0];
const GIF_GAMMA = [0x21, 0xff, 11, ...text("ImageMagick"), 7, ...text("gamma=1"), 0];
const gif = (...blocks: number[][]) => gifOf("GIF89a", NETSCAPE, ...blocks, GIF_IMAGE);

const SVG = bytes(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
const HTML = bytes(text("<!doctype html><title>x</title><script>alert(1)</script>"));

describe("sniffing", () => {
  it.each([
    ["jpg", jpeg()],
    ["png", png()],
    ["webp", webp()],
    ["gif", gif()],
    ["gif", gifOf("GIF87a", GIF_IMAGE)],
    [null, SVG],
    [null, HTML],
    [null, bytes(text("RIFF\0\0\0\0WAVEfmt "))],
    [null, new Uint8Array()],
  ])("sees %s", (type, file) => {
    expect(sniffImage(file)).toBe(type);
  });
});

describe("create", () => {
  it("writes a pending row and returns the key and widths to upload", async () => {
    const { status, json, response } = await call("POST", "", {
      draftId,
      ext: "webp",
      width: 2048,
      height: 1365,
    });
    expect(status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json).toEqual({ id: json.id, src: `blog/${json.id}.webp`, widths: [480, 1024, 2048] });
    expect(row(json.id)).toMatchObject({ state: "pending", widths: "[]", published: 0 });
  });

  it("asks for fewer widths for a smaller image, and one for a GIF", async () => {
    expect((await createImage("jpg", 800)).widths).toEqual([480, 800]);
    expect((await createImage("gif", 1600)).widths).toEqual([1600]);
  });

  it("is 404 for a draft that doesn't exist", async () => {
    draftId = "00000000-0000-4000-8000-000000000000";
    const { status, json } = await call("POST", "", { draftId, ext: "webp", width: 9, height: 9 });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM images").all()[0]).toEqual({ n: 0 });
  });

  it.each([
    [{ ext: "svg" }, 422],
    [{ ext: "jpeg" }, 422],
    [{ width: 0 }, 422],
    [{ width: 2049 }, 422],
    [{ width: 300.5 }, 422],
    [{ width: "300" }, 422],
    [{ height: 16385 }, 422],
    [{ draftId: "not-an-id" }, 422],
    [{ alt: "extra" }, 422],
  ])("refuses %j with %i", async (change, status) => {
    const body = { draftId, ext: "webp", width: 300, height: 200, ...change };
    const response = await call("POST", "", body);
    expect(response.status).toBe(status);
    expect(response.json.error.code).toBe("invalid_image");
  });

  it("refuses bad JSON, wrong methods and unknown paths", async () => {
    expect((await call("POST", "", "{nope")).status).toBe(400);
    expect((await call("POST", "", [1])).status).toBe(400);
    expect((await call("GET", "")).status).toBe(405);
    expect((await call("GET", "/published")).status).toBe(405);
    const id = (await createImage()).id;
    expect((await call("GET", `/${id}/300`)).status).toBe(405);
    expect(await handleImages(new Request(`${SITE}/api/admin/images/${id}`), env())).toBeNull();
    expect(await handleImages(new Request(`${SITE}/api/admin/drafts`), env())).toBeNull();
  });
});

describe("upload", () => {
  it.each([
    ["a JPEG", "jpg", jpeg(), "image/jpeg"],
    ["a JPEG with an ICC profile", "jpg", jpeg(ICC), "image/jpeg"],
    [
      "a progressive JPEG",
      "jpg",
      jpegOf(JFIF, TABLES, frame(0xc2), SCAN, TABLES, SCAN),
      "image/jpeg",
    ],
    ["a PNG", "png", png(), "image/png"],
    [
      "a PNG with a plain text chunk",
      "png",
      png(chunk("tEXt", [...text("Software"), 0, 1])),
      "image/png",
    ],
    ["a WebP", "webp", webp(), "image/webp"],
    [
      "a WebP with alpha",
      "webp",
      webpOf(vp8x(0x10), riff("ALPH", [0]), riff("VP8 ", [1, 2])),
      "image/webp",
    ],
    ["a GIF", "gif", gif(COMMENT), "image/gif"],
    ["a GIF from ImageMagick", "gif", gif(GIF_GAMMA), "image/gif"],
    ["a GIF87a", "gif", gifOf("GIF87a", GIF_IMAGE), "image/gif"],
  ])("accepts %s", async (_, ext, file, mediaType) => {
    const { id, src } = await createImage(ext);
    const { status, json, response } = await put(id, 300, file, { "Content-Type": mediaType });
    expect(status).toBe(200);
    expect(json).toEqual({ state: "ready" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const object = objects.get(variantKey(src, 300));
    expect(object?.body).toEqual(file);
    expect(object?.httpMetadata).toEqual({
      contentType: mediaType,
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: "inline",
    });
  });

  it("stores a GIF once, at its src with no width suffix", async () => {
    const { id, src, widths } = await createImage("gif", 1600, 900);
    expect(widths).toEqual([1600]);
    expect((await put(id, 1600, gif(), { "Content-Type": "image/gif" })).json.state).toBe("ready");
    expect([...objects.keys()]).toEqual([`blog/${id}.gif`]);
    expect(src).toBe(`blog/${id}.gif`);
  });

  it("stores every width and turns ready after the last one", async () => {
    const { id, src, widths } = await createImage("webp", 2048, 1365);
    const file = webp();
    expect((await put(id, 2048, file)).json).toEqual({ state: "pending" });
    expect((await put(id, 480, file)).json).toEqual({ state: "pending" });
    expect(row(id)).toMatchObject({ state: "pending", widths: "[480,2048]" });
    expect((await put(id, 1024, file)).json).toEqual({ state: "ready" });
    expect(row(id)).toMatchObject({ widths: "[480,1024,2048]", bytes: 3 * file.byteLength });
    expect([...objects.keys()].sort()).toEqual(widths.map((w) => variantKey(src, w)).sort());
    expect(objects.has(`blog/${id}-1024.webp`)).toBe(true);

    // Putting a width again replaces the same key, keeps the state and counts its bytes once.
    expect((await put(id, 480, file)).json).toEqual({ state: "ready" });
    expect(row(id)).toMatchObject({ widths: "[480,1024,2048]", bytes: 3 * file.byteLength });
  });

  it("keeps every width when the uploads overlap", async () => {
    const { id } = await createImage("webp", 2048, 1365);
    const results = await Promise.all([2048, 1024, 480].map((w) => put(id, w, webp())));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(row(id)).toMatchObject({ state: "ready", widths: "[480,1024,2048]" });
  });

  it.each([
    ["SVG", "webp", SVG, "image/svg+xml", "unsupported_type"],
    ["HTML", "webp", HTML, "image/webp", "unsupported_type"],
    ["a GIF renamed .webp", "webp", gif(), "image/webp", "unsupported_type"],
    ["a PNG on a JPEG row", "jpg", png(), "image/png", "unsupported_type"],
    ["an empty body", "webp", new Uint8Array(), "image/webp", "unsupported_type"],
    [
      "a phone JPEG with EXIF and GPS",
      "jpg",
      jpegOf(exifWithGps(), TABLES, frame(), SCAN),
      "image/jpeg",
      "image_metadata",
    ],
    ["a JPEG with XMP", "jpg", jpeg(JPEG_XMP), "image/jpeg", "image_metadata"],
    ["a JPEG with IPTC", "jpg", jpeg(JPEG_IPTC), "image/jpeg", "image_metadata"],
    [
      "a progressive JPEG with XMP between scans",
      "jpg",
      jpegOf(JFIF, TABLES, frame(0xc2), SCAN, JPEG_XMP, SCAN),
      "image/jpeg",
      "image_metadata",
    ],
    ["a JPEG cut short", "jpg", jpeg().slice(0, -2), "image/jpeg", "unsupported_type"],
    ["a JPEG cut inside a segment", "jpg", jpeg().slice(0, 12), "image/jpeg", "unsupported_type"],
    [
      "a PNG with eXIf",
      "png",
      png(chunk("eXIf", [...text("MM"), 0, 42])),
      "image/png",
      "image_metadata",
    ],
    [
      "a PNG with XMP in iTXt",
      "png",
      png(chunk("iTXt", [...text("XML:com.adobe.xmp"), 0, 0, 0, 0, 0, ...XMP])),
      "image/png",
      "image_metadata",
    ],
    [
      "a PNG with a raw EXIF profile",
      "png",
      png(chunk("tEXt", [...text("Raw profile type exif"), 0, 10])),
      "image/png",
      "image_metadata",
    ],
    [
      "a PNG with a raw XMP profile",
      "png",
      png(chunk("zTXt", [...text("Raw profile type xmp"), 0, 0, 1])),
      "image/png",
      "image_metadata",
    ],
    ["a PNG without IEND", "png", png().slice(0, -12), "image/png", "unsupported_type"],
    [
      "a PNG that doesn't start with IHDR",
      "png",
      bytes(PNG_SIGNATURE, chunk("IEND", [])),
      "image/png",
      "unsupported_type",
    ],
    [
      "a WebP with an EXIF chunk",
      "webp",
      webpOf(vp8x(0x08), VP8L, riff("EXIF", [...text("MM"), 0, 42])),
      "image/webp",
      "image_metadata",
    ],
    [
      "a WebP with an XMP chunk",
      "webp",
      webpOf(vp8x(0x04), VP8L, riff("XMP ", XMP)),
      "image/webp",
      "image_metadata",
    ],
    [
      "a WebP whose VP8X announces EXIF",
      "webp",
      webpOf(vp8x(0x08), VP8L),
      "image/webp",
      "image_metadata",
    ],
    [
      "a WebP whose VP8X announces XMP",
      "webp",
      webpOf(vp8x(0x04), VP8L),
      "image/webp",
      "image_metadata",
    ],
    [
      "a WebP with an EXIF chunk but no flags",
      "webp",
      webpOf(VP8L, riff("EXIF", [0])),
      "image/webp",
      "image_metadata",
    ],
    ["a WebP cut short", "webp", webp().slice(0, -2), "image/webp", "unsupported_type"],
    [
      "a WebP without image data",
      "webp",
      webpOf(riff("JUNK", [0, 0])),
      "image/webp",
      "unsupported_type",
    ],
    ["a GIF with XMP", "gif", gif(GIF_XMP), "image/gif", "image_metadata"],
    ["a GIF with a Photoshop block", "gif", gif(GIF_8BIM), "image/gif", "image_metadata"],
    ["a GIF without its trailer", "gif", gif().slice(0, -1), "image/gif", "unsupported_type"],
  ])("refuses %s with 415", async (_, ext, file, mediaType, code) => {
    const { id } = await createImage(ext);
    const { status, json } = await put(id, 300, file, { "Content-Type": mediaType });
    expect(status).toBe(415);
    expect(json.error.code).toBe(code);
    expect(objects.size).toBe(0);
    expect(row(id)).toMatchObject({ state: "pending", widths: "[]" });
  });

  it("needs a Content-Length of at most 10 MB, and checks the body too", async () => {
    const { id } = await createImage();
    const noLength = await send(
      new Request(`${SITE}/api/admin/images/${id}/300`, {
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: webp(),
      }),
    );
    expect(noLength.status).toBe(411);
    expect(noLength.json.error.code).toBe("length_required");

    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(webp());
    expect((await put(id, 300, big)).status).toBe(413);
    const understated = await put(id, 300, big, { "Content-Length": "100" });
    expect(understated.status).toBe(413);
    expect(objects.size).toBe(0);
  });

  it("refuses unknown images and widths it wasn't created with", async () => {
    const { id } = await createImage("webp", 2048, 1365);
    const unknown = await put("00000000-0000-4000-8000-000000000000", 480, webp());
    expect(unknown.status).toBe(404);
    expect((await put("nope", 480, webp())).status).toBe(404);
    expect((await put(id, 0, webp())).status).toBe(404);
    const other = await put(id, 800, webp());
    expect(other.status).toBe(422);
    expect(other.json.error.code).toBe("invalid_image");
    expect(objects.size).toBe(0);
  });

  it("refuses to replace a published image", async () => {
    const { id, src } = await createImage();
    await put(id, 300, webp());
    sqlite.prepare("UPDATE images SET published = 1 WHERE id = ?").run(id);
    const replaced = await put(id, 300, webpOf(vp8x(0), VP8L));
    expect(replaced.status).toBe(409);
    expect(replaced.json.error.code).toBe("published");
    expect(objects.get(variantKey(src, 300))?.body).toEqual(webp());
  });

  it("removes the object when the row went while the bytes were on their way", async () => {
    const { id } = await createImage();
    const store = photos.put.bind(photos);
    photos = {
      ...photos,
      put: (async (...args: Parameters<R2Bucket["put"]>) => {
        sqlite.prepare("DELETE FROM images WHERE id = ?").run(id);
        return store(...args);
      }) as R2Bucket["put"],
    };
    expect((await put(id, 300, webp())).status).toBe(404);
    expect(objects.size).toBe(0);
  });

  it("removes the object when the draft was discarded while the bytes were on their way", async () => {
    const { id } = await createImage();
    const store = photos.put.bind(photos);
    photos = {
      ...photos,
      put: (async (...args: Parameters<R2Bucket["put"]>) => {
        // The discard has chosen this image and deleted its objects; its row is still there.
        sqlite.prepare("UPDATE images SET draft_id = NULL WHERE id = ?").run(id);
        return store(...args);
      }) as R2Bucket["put"],
    };
    expect((await put(id, 300, webp())).status).toBe(404);
    expect(objects.size).toBe(0);
    expect(row(id)).toMatchObject({ state: "pending" });
  });

  it("refuses uploads to an image whose draft was discarded", async () => {
    const { id } = await createImage();
    sqlite.prepare("UPDATE images SET draft_id = NULL WHERE id = ?").run(id);
    expect((await put(id, 300, webp())).status).toBe(404);
    expect(objects.size).toBe(0);
  });
});

describe("published", () => {
  it("marks ready and orphaned images published, and leaves uploads alone", async () => {
    const ready = await createImage();
    await put(ready.id, 300, webp());
    const orphan = await createImage();
    await put(orphan.id, 300, webp());
    sqlite
      .prepare("UPDATE images SET state = 'orphan', orphaned_at = 5 WHERE id = ?")
      .run(orphan.id);
    const pending = await createImage();

    const srcs = [
      ready.src,
      orphan.src,
      pending.src,
      ready.src,
      ready.src.replace(".webp", ".png"),
    ];
    const { status, json } = await call("POST", "/published", { srcs });
    expect(status).toBe(200);
    expect(json).toEqual({ published: 2 });
    expect(row(ready.id)).toMatchObject({ state: "ready", published: 1 });
    expect(row(orphan.id)).toMatchObject({ state: "ready", published: 1, orphaned_at: null });
    expect(row(pending.id)).toMatchObject({ state: "pending", published: 0 });
  });

  it("accepts an empty list and refuses anything but figure keys", async () => {
    expect((await call("POST", "/published", { srcs: [] })).json).toEqual({ published: 0 });
    const url = "https://photos.ry-mart.com/blog/00000000-0000-4000-8000-000000000000.webp";
    const tooMany = Array.from({ length: 201 }, () => `blog/${crypto.randomUUID()}.webp`);
    for (const body of [{ srcs: [url] }, { srcs: "x" }, { srcs: tooMany }, { srcs: [], x: 1 }]) {
      const response = await call("POST", "/published", body);
      expect(response.status).toBe(422);
      expect(response.json.error.code).toBe("invalid_image");
    }
  });

  it("a downloaded draft's images survive its discard; the others go", async () => {
    const downloaded = await createImage();
    await put(downloaded.id, 300, webp());
    const unused = await createImage();
    await put(unused.id, 300, webp());
    await call("POST", "/published", { srcs: [downloaded.src] });

    const discard = new Request(`${SITE}/api/admin/drafts/${draftId}`, { method: "DELETE" });
    expect((await handleDrafts(discard, env()))?.status).toBe(204);
    expect(objects.has(variantKey(downloaded.src, 300))).toBe(true);
    expect(row(downloaded.id)).toMatchObject({ published: 1 });
    expect(objects.has(variantKey(unused.src, 300))).toBe(false);
    expect(row(unused.id)).toBeUndefined();
  });
});

describe("daily clean-up", () => {
  const NOW = Date.UTC(2026, 9, 13, 4, 23);

  /** An image row with its objects, as an upload leaves it. */
  function addImage(
    draft: string | null,
    {
      state = "ready",
      published = 0,
      createdAt = NOW - 30 * DAY,
      orphanedAt = null as number | null,
    },
  ) {
    const id = crypto.randomUUID();
    const src = `blog/${id}.webp`;
    const widths = figureWidths(src, 1024);
    sqlite
      .prepare(
        "INSERT INTO images (id, draft_id, ext, widths, width, height, state, published, " +
          "created_at, orphaned_at) VALUES (?, ?, 'webp', ?, 1024, 683, ?, ?, ?, ?)",
      )
      .run(id, draft, JSON.stringify(widths), state, published, createdAt, orphanedAt);
    for (const width of widths) {
      objects.set(variantKey(src, width), { body: new Uint8Array([1]), httpMetadata: {} });
    }
    return { id, src };
  }
  const figure = (src: string) => `::figure[]{src="${src}" alt="A photo" w="1024" h="683"}`;

  it("deletes stale uploads and old unpublished orphans, and keeps the rest", async () => {
    const deleted = {
      stalePending: addImage(draftId, { state: "pending", createdAt: NOW - 2 * DAY }),
      oldOrphan: addImage(draftId, { state: "orphan", orphanedAt: NOW - 8 * DAY }),
      draftless: addImage(null, { createdAt: NOW - 2 * DAY }),
      // Uploaded, then the dialog was cancelled: no body ever mentioned it.
      neverInserted: addImage(draftId, { createdAt: NOW - 8 * DAY }),
    };
    const kept = {
      freshPending: addImage(draftId, { state: "pending", createdAt: NOW - DAY / 2 }),
      recentOrphan: addImage(draftId, { state: "orphan", orphanedAt: NOW - 6 * DAY }),
      recentReady: addImage(draftId, { createdAt: NOW - 6 * DAY }),
      readyInBody: addImage(draftId, { createdAt: NOW - 90 * DAY }),
      publishedOrphan: addImage(draftId, {
        state: "orphan",
        published: 1,
        orphanedAt: NOW - 30 * DAY,
      }),
      publishedDraftless: addImage(null, { published: 1 }),
      freshDraftless: addImage(null, { createdAt: NOW - DAY / 2 }),
      orphanInRevision: addImage(draftId, { state: "orphan", orphanedAt: NOW - 8 * DAY }),
      draftlessInOtherDraft: addImage(null, { createdAt: NOW - 2 * DAY }),
      pendingInBody: addImage(draftId, { state: "pending", createdAt: NOW - 2 * DAY }),
    };
    addDraft(figure(kept.draftlessInOtherDraft.src));
    sqlite
      .prepare("UPDATE drafts SET body_md = ? WHERE id = ?")
      .run(`${figure(kept.pendingInBody.src)}\n\n${figure(kept.readyInBody.src)}`, draftId);
    sqlite
      .prepare(
        "INSERT INTO draft_revisions (draft_id, rev, title, body_md, meta, reason, created_at) " +
          "VALUES (?, 1, '', ?, '{}', 'manual', 0)",
      )
      .run(draftId, figure(kept.orphanInRevision.src));

    expect(await cleanUpImages(env(), NOW)).toBe(4);
    const has = (src: string) =>
      figureWidths(src, 1024).map((w) => objects.has(variantKey(src, w)));
    for (const image of Object.values(deleted)) {
      expect(row(image.id)).toBeUndefined();
      expect(has(image.src)).toEqual([false, false]);
    }
    for (const image of Object.values(kept)) {
      expect(row(image.id)).toBeDefined();
      expect(has(image.src)).toEqual([true, true]);
    }
    // Nothing is left to do the next day.
    expect(await cleanUpImages(env(), NOW + DAY / 4)).toBe(0);
  });

  it("deletes every possible key, even of a width the row never recorded", async () => {
    const { id, src } = addImage(draftId, { state: "pending", createdAt: NOW - 2 * DAY });
    sqlite.prepare("UPDATE images SET widths = '[480]' WHERE id = ?").run(id);
    expect(await cleanUpImages(env(), NOW)).toBe(1);
    expect(objects.has(variantKey(src, 1024))).toBe(false);
  });
});
