import { beforeEach, describe, expect, it } from "vitest";
import { createD1 } from "./d1-fake";
import { cleanUpPhotos, handlePhotos } from "./photos";
import { createR2, type StoredObject } from "./r2-fake";

// The photos API against a real SQLite database with the shipped migrations and an in-memory R2
// bucket. The upload checks themselves are shared with the editor's images and tested in
// images.test.ts; these tests cover what is new: the rows, the keys and when a photo shows.

const SITE = "https://ry-mart.com";
const DAY = 24 * 60 * 60 * 1000;
let db: D1Database;
let sqlite: Awaited<ReturnType<typeof createD1>>["sqlite"];
let photos: R2Bucket;
let objects: Map<string, StoredObject>;

beforeEach(async () => {
  ({ db, sqlite } = await createD1());
  ({ bucket: photos, objects } = createR2());
});

const env = () => ({ DB: db, PHOTOS: photos });

async function send(request: Request) {
  const response = await handlePhotos(request, env());
  if (!response) throw new Error(`no route for ${request.method} ${request.url}`);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

const call = (method: string, path: string, body?: unknown) =>
  send(
    new Request(`${SITE}/api/admin/photos${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const put = (id: string, width: number, bytes: Uint8Array<ArrayBuffer>, type = "image/webp") =>
  send(
    new Request(`${SITE}/api/admin/photos/${id}/${width}`, {
      method: "PUT",
      headers: { "Content-Length": String(bytes.byteLength), "Content-Type": type },
      body: bytes,
    }),
  );

// The smallest files the Worker's scan accepts (see images.test.ts for how they are built).
const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
const u16be = (n: number) => [n >> 8, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
function webp() {
  const body = [...text("WEBP"), ...text("VP8L"), ...u32le(5), 0x2f, 0x2b, 0xc0, 0x31, 0x00, 0];
  return Uint8Array.from([...text("RIFF"), ...u32le(body.length), ...body]);
}
const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  ...u16be(payload.length + 2),
  ...payload,
];
/** A JPEG with an EXIF block, which the Worker refuses. */
const jpegWithExif = () =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...segment(0xe1, [...text("Exif"), 0, 0, 0, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    0x12,
    0xff,
    0xd9,
  ]);

async function createPhoto(fields: Record<string, unknown> = {}) {
  const { status, json } = await call("POST", "", {
    ext: "webp",
    width: 1200,
    height: 800,
    ...fields,
  });
  expect(status).toBe(201);
  return json as { id: string; widths: number[] };
}

async function uploadAll(id: string, widths: number[]) {
  for (const width of widths) expect((await put(id, width, webp())).status).toBe(200);
}

describe("photos API", () => {
  it("shows a photo with its caption only once every width is stored", async () => {
    const { id, widths } = await createPhoto({ caption: "  Half Dome\n at dusk ", alt: "" });
    expect(widths).toEqual([480, 1024, 1200]);
    expect((await call("GET", "")).json.photos).toEqual([]);

    expect((await put(id, 480, webp())).json).toEqual({ state: "pending" });
    expect((await put(id, 1024, webp())).json).toEqual({ state: "pending" });
    expect((await put(id, 1200, webp())).json).toEqual({ state: "ready" });

    expect([...objects.keys()].sort()).toEqual(
      [480, 1024, 1200].map((w) => `photos/${id}-${w}.webp`).sort(),
    );
    expect(objects.get(`photos/${id}-480.webp`)?.httpMetadata.cacheControl).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await put(id, 480, webp())).status).toBe(409);
    const [photo] = (await call("GET", "")).json.photos;
    expect(photo).toMatchObject({
      id,
      ext: "webp",
      width: 1200,
      height: 800,
      caption: "Half Dome at dusk",
      alt: "",
    });
  });

  it("refuses a file with metadata, a file of another type and a width it didn't ask for", async () => {
    const { id } = await createPhoto({ ext: "jpg" });
    expect((await put(id, 480, jpegWithExif(), "image/jpeg")).json.error.code).toBe(
      "image_metadata",
    );
    expect((await put(id, 480, webp())).status).toBe(415);
    expect((await put(id, 700, webp())).status).toBe(422);
    expect(objects.size).toBe(0);
  });

  it("refuses bad fields", async () => {
    for (const body of [
      { ext: "png", width: 10, height: 10 },
      { ext: "webp", width: 4000, height: 10 },
      { ext: "webp", width: 10, height: 10, album: "x" },
      { ext: "webp", width: 10, height: 10, caption: 5 },
      { ext: "webp", width: 10, height: 10, caption: "x".repeat(501) },
    ]) {
      expect((await call("POST", "", body)).status).toBe(422);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM photos").all()[0]).toEqual({ n: 0 });
  });

  it("changes a caption and leaves the alt text when it isn't sent", async () => {
    const { id, widths } = await createPhoto({ caption: "Old", alt: "A mountain" });
    await uploadAll(id, widths);
    const { status, json } = await call("PATCH", `/${id}`, { caption: "New caption" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ caption: "New caption", alt: "A mountain" });
    expect((await call("PATCH", `/${crypto.randomUUID()}`, { caption: "x" })).status).toBe(404);
  });

  it("deletes a photo's objects and row", async () => {
    const { id, widths } = await createPhoto();
    await uploadAll(id, widths);
    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    expect(objects.size).toBe(0);
    expect((await call("GET", "")).json.photos).toEqual([]);
    expect((await call("DELETE", `/${id}`)).status).toBe(404);
    // A variant that arrives after the delete isn't left behind.
    expect((await put(id, 480, webp())).status).toBe(404);
    expect(objects.size).toBe(0);
  });

  it("answers 405 and 404 for other methods and paths", async () => {
    expect((await call("PUT", "")).status).toBe(405);
    expect((await call("GET", `/${crypto.randomUUID()}`)).status).toBe(405);
    expect((await call("PATCH", "/not-an-id", {})).status).toBe(404);
  });
});

describe("cleanUpPhotos", () => {
  it("deletes uploads that never finished after a day, and nothing else", async () => {
    const stale = await createPhoto();
    await put(stale.id, 480, webp());
    const done = await createPhoto();
    await uploadAll(done.id, done.widths);
    const fresh = await createPhoto();
    sqlite
      .prepare("UPDATE photos SET created_at = ? WHERE id IN (?, ?)")
      .run(Date.now() - 2 * DAY, stale.id, done.id);

    expect(await cleanUpPhotos(env(), Date.now())).toBe(1);
    const left = sqlite.prepare("SELECT id FROM photos ORDER BY id").all();
    expect(left.map((row) => row.id).sort()).toEqual([done.id, fresh.id].sort());
    expect([...objects.keys()].some((key) => key.includes(stale.id))).toBe(false);
  });
});
