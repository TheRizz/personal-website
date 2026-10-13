import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The preview map and the session-expired flag live in their modules, so each test gets fresh
// copies. Vitest runs in Node, so the canvas, createImageBitmap and XMLHttpRequest are fakes.
let images: typeof import("./images");
let api: typeof import("./api");

beforeEach(async () => {
  vi.resetModules();
  images = await import("./images");
  api = await import("./api");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const UUID = "2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? [...new TextEncoder().encode(part)] : part,
    ),
  );

const le16 = (n: number) => [n & 0xff, n >> 8];

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF");
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d], "IHDR");
const WEBP = bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ");
const gif = (width: number, height: number, version = "GIF89a") =>
  bytes(version, le16(width), le16(height), [0xf7, 0, 0], ";");
// What Safari's canvas writes (through ImageIO): JFIF, an EXIF block with only the size and
// colour space, an empty Photoshop block, then the image.
const SAFARI_JPEG = bytes(
  [0xff, 0xd8],
  [0xff, 0xe0, 0, 16],
  "JFIF",
  [0, 1, 1, 0, 0, 0x48, 0, 0x48, 0, 0],
  [0xff, 0xe1, 0, 14],
  "Exif",
  [0, 0],
  "MM",
  [0, 0x2a, 0, 0],
  [0xff, 0xed, 0, 16],
  "Photoshop 3.0",
  [0],
  [0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0],
  [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0],
  [0x12, 0x34, 0xff, 0xd9],
);
const ftyp = (major: string, ...compatible: string[]) =>
  bytes([0, 0, 0, 16 + 4 * compatible.length], "ftyp", major, [0, 0, 0, 0], ...compatible);

describe("sniffImage", () => {
  it.each([
    ["a JPEG", JPEG, "jpg"],
    ["a PNG", PNG, "png"],
    ["a GIF89a", gif(10, 10), "gif"],
    ["a GIF87a", gif(10, 10, "GIF87a"), "gif"],
    ["a WebP", WEBP, "webp"],
    ["an AVIF", ftyp("avif", "mif1", "miaf"), "avif"],
    ["an AVIF sequence", ftyp("avis", "msf1"), "avif"],
    ["an AVIF by compatible brand", ftyp("mif1", "miaf", "avif"), "avif"],
    ["an SVG", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), "svg"],
    ["an SVG with a prologue", bytes('﻿\n <?xml version="1.0"?>\n<!-- x -->\n<svg>'), "svg"],
    ["a HEIC", ftyp("heic", "mif1", "heic"), null],
    ["HTML", bytes("<!doctype html><p>hi</p>"), null],
    ["a WAV", bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "), null],
    ["a cut-off GIF signature", bytes("GIF8"), null],
    ["text", bytes("hello <svg> world"), null],
    ["nothing", new Uint8Array(), null],
  ])("reads %s", (_name, file, type) => {
    expect(images.sniffImage(file)).toBe(type);
  });

  it("reads a view into a larger buffer", () => {
    const buffer = new Uint8Array([1, 2, 3, ...gif(640, 480)]);
    const view = buffer.subarray(3);
    expect(images.sniffImage(view)).toBe("gif");
    expect(images.gifSize(view)).toEqual({ width: 640, height: 480 });
  });
});

describe("gifSize", () => {
  it("reads the logical screen size, little-endian", () => {
    expect(images.gifSize(gif(1, 1))).toEqual({ width: 1, height: 1 });
    expect(images.gifSize(gif(2048, 300))).toEqual({ width: 2048, height: 300 });
    expect(images.gifSize(gif(65535, 258))).toEqual({ width: 65535, height: 258 });
  });

  it("refuses a cut-off or empty header", () => {
    expect(images.gifSize(gif(10, 10).subarray(0, 9))).toBeNull();
    expect(images.gifSize(gif(0, 10))).toBeNull();
    expect(images.gifSize(gif(10, 0))).toBeNull();
  });
});

describe("targetSize", () => {
  it("scales down to 2048 wide and rounds the height", () => {
    expect(images.targetSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(images.targetSize(3000, 2000)).toEqual({ width: 2048, height: 1365 });
    expect(images.targetSize(2049, 1000)).toEqual({ width: 2048, height: 1000 });
  });

  it("never upscales", () => {
    expect(images.targetSize(2048, 100)).toEqual({ width: 2048, height: 100 });
    expect(images.targetSize(400, 300)).toEqual({ width: 400, height: 300 });
  });

  it("keeps at least one pixel of height", () => {
    expect(images.targetSize(10_000, 1)).toEqual({ width: 2048, height: 1 });
  });

  it("takes another width, for the smaller variants", () => {
    expect(images.targetSize(3000, 2000, 480)).toEqual({ width: 480, height: 320 });
    expect(images.targetSize(3000, 2000, 1024)).toEqual({ width: 1024, height: 683 });
  });
});

/** createImageBitmap and OffscreenCanvas fakes; `webp: false` encodes PNG instead, as Safari does. */
function fakeCanvas({ width = 3000, height = 2000, webp = true } = {}) {
  const close = vi.fn();
  const decode = vi.fn(async (_file: Blob, _options?: ImageBitmapOptions) => ({
    width,
    height,
    close,
  }));
  const canvases: FakeOffscreenCanvas[] = [];
  class FakeOffscreenCanvas {
    context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    };
    encoded: { type?: string; quality?: number } = {};
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      canvases.push(this);
    }
    getContext() {
      return this.context;
    }
    async convertToBlob(options: { type?: string; quality?: number }) {
      this.encoded = options;
      const type = options.type === "image/webp" && !webp ? "image/png" : options.type;
      return new Blob([type === "image/jpeg" ? SAFARI_JPEG : new Uint8Array(this.width)], {
        type,
      });
    }
  }
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return { decode, close, canvases };
}

describe("prepareImage", () => {
  it("re-encodes a photo to WebP variants, applying the EXIF rotation", async () => {
    const { decode, close, canvases } = fakeCanvas();
    const prepared = await images.prepareImage(new File([JPEG], "photo.jpg"));
    expect(decode.mock.calls[0]![1]).toEqual({ imageOrientation: "from-image" });
    expect(prepared).toMatchObject({ ext: "webp", width: 2048, height: 1365 });
    expect(prepared.variants.map((v) => [v.width, v.blob.type])).toEqual([
      [480, "image/webp"],
      [1024, "image/webp"],
      [2048, "image/webp"],
    ]);
    expect(canvases.map((c) => [c.width, c.height])).toEqual([
      [480, 320],
      [1024, 683],
      [2048, 1365],
    ]);
    for (const canvas of canvases) {
      expect(canvas.encoded).toEqual({ type: "image/webp", quality: 0.8 });
      expect(canvas.context.imageSmoothingQuality).toBe("high");
      expect(canvas.context.drawImage).toHaveBeenCalledWith(
        expect.anything(),
        0,
        0,
        canvas.width,
        canvas.height,
      );
      expect(canvas.context.fillRect).not.toHaveBeenCalled();
    }
    expect(prepared.previewUrl).toMatch(/^blob:/);
    expect(close).toHaveBeenCalledOnce();
  });

  it("falls back to JPEG on a white background when the browser can't encode WebP", async () => {
    const { canvases } = fakeCanvas({ webp: false });
    const prepared = await images.prepareImage(new File([PNG], "screenshot.png"));
    expect(prepared.ext).toBe("jpg");
    expect(prepared.variants.map((v) => [v.width, v.blob.type])).toEqual([
      [480, "image/jpeg"],
      [1024, "image/jpeg"],
      [2048, "image/jpeg"],
    ]);
    // The first variant is tried as WebP once, then everything is JPEG at 0.82.
    expect(canvases.map((c) => c.encoded.type)).toEqual([
      "image/webp",
      "image/jpeg",
      "image/jpeg",
      "image/jpeg",
    ]);
    expect(canvases.at(-1)!.encoded.quality).toBe(0.82);
    expect(canvases.at(-1)!.context.fillRect).toHaveBeenCalledWith(0, 0, 2048, 1365);
  });

  it("strips the EXIF and Photoshop blocks Safari's JPEG encoder adds, so the Worker takes it", async () => {
    const { scanImage } = await import("../../../worker/images");
    expect(scanImage(SAFARI_JPEG, "jpg")).toBe("metadata");
    fakeCanvas({ webp: false });
    const prepared = await images.prepareImage(new File([PNG], "screenshot.png"));
    for (const { blob } of prepared.variants) {
      const encoded = new Uint8Array(await blob.arrayBuffer());
      expect(scanImage(encoded, "jpg")).toBe("clean");
      // JFIF, the frame and the scan are all still there.
      expect(encoded).toEqual(
        bytes([...SAFARI_JPEG.subarray(0, 20)], [...SAFARI_JPEG.subarray(-27)]),
      );
    }
  });

  it("refuses a broken JPEG rather than upload it unchecked", () => {
    expect(images.stripJpegMetadata(bytes([0xff, 0xd8, 0xff, 0xe1, 0, 40]))).toBeNull();
    expect(images.stripJpegMetadata(PNG)).toBeNull();
  });

  it("keeps a small image at its own size, in one variant", async () => {
    fakeCanvas({ width: 400, height: 300 });
    const prepared = await images.prepareImage(new File([WEBP], "small.webp"));
    expect(prepared).toMatchObject({ ext: "webp", width: 400, height: 300 });
    expect(prepared.variants.map((v) => v.width)).toEqual([400]);
  });

  it("refuses a file the browser can't open", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      }),
    );
    await expect(images.prepareImage(new File([bytes("%PDF-1.7")], "a.jpg"))).rejects.toThrow(
      images.ImageError,
    );
  });

  it("uploads a GIF as it is, sniffed by its bytes rather than its name or type", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const file = new File([gif(800, 600)], "cat.png", { type: "image/png" });
    const prepared = await images.prepareImage(file);
    expect(prepared).toMatchObject({ ext: "gif", width: 800, height: 600 });
    expect(prepared.variants).toEqual([{ width: 800, blob: file }]);
    expect(prepared.previewUrl).toMatch(/^blob:/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses a GIF wider than 2048 pixels or larger than 10 MB", async () => {
    await expect(images.prepareImage(new File([gif(2049, 10)], "a.gif"))).rejects.toThrow(
      /2049 pixels wide/,
    );
    const big = new File([gif(100, 100), new Uint8Array(images.MAX_UPLOAD_BYTES)], "a.gif");
    await expect(images.prepareImage(big)).rejects.toThrow(/larger than 10 MB/);
    await expect(images.prepareImage(new File([bytes("GIF89a", [1])], "a.gif"))).rejects.toThrow(
      /damaged/,
    );
  });

  it("refuses SVG and AVIF whatever the file is called", async () => {
    const svg = new File([bytes("<svg onload='alert(1)'/>")], "a.jpg", { type: "image/jpeg" });
    await expect(images.prepareImage(svg)).rejects.toThrow(images.ImageError);
    await expect(images.prepareImage(svg)).rejects.toThrow(/SVG/);
    const avif = new File([ftyp("avif", "mif1")], "a.png");
    await expect(images.prepareImage(avif)).rejects.toThrow(/AVIF/);
  });
});

describe("figureSrcs", () => {
  it("lists every figure key once, in order", () => {
    const markdown = [
      "# Title",
      "",
      `::figure[A caption]{src="blog/${UUID}.webp" alt="A" size="wide" w="2048" h="1365"}`,
      "",
      `Prose that mentions src="blog/00000000-0000-4000-8000-000000000000.webp".`,
      "",
      `::figure{src="blog/11111111-1111-4111-8111-111111111111.gif" alt="B" w="300" h="200"}`,
      `::figure[Again]{src="blog/${UUID}.webp" alt="A again" w="2048" h="1365"}`,
      `::figure{alt="C" src='blog/22222222-2222-4222-8222-222222222222.jpg' w="9" h="9"}\r`,
      `::figure{src="https://evil.example/a.webp" alt="D" w="1" h="1"}`,
      `::figure{src="blog/not-a-uuid.webp" alt="E" w="1" h="1"}`,
    ].join("\n");
    expect(images.figureSrcs(markdown)).toEqual([
      `blog/${UUID}.webp`,
      "blog/11111111-1111-4111-8111-111111111111.gif",
      "blog/22222222-2222-4222-8222-222222222222.jpg",
    ]);
  });

  it("finds nothing in a body without figures", () => {
    expect(images.figureSrcs("")).toEqual([]);
    expect(images.figureSrcs("Just text.\n")).toEqual([]);
  });
});

describe("previews", () => {
  it("remembers a blob: URL per image key", () => {
    expect(images.previewFor(`blog/${UUID}.webp`)).toBeUndefined();
    images.rememberPreview(`blog/${UUID}.webp`, "blob:x");
    expect(images.previewFor(`blog/${UUID}.webp`)).toBe("blob:x");
  });

  it("forgets and revokes a preview whose image was never inserted", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    images.rememberPreview(`blog/${UUID}.webp`, "blob:x");
    images.forgetPreview(`blog/${UUID}.webp`);
    expect(images.previewFor(`blog/${UUID}.webp`)).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:x");
    revoke.mockRestore();
  });
});

/** XMLHttpRequest fake: each `send` hands the request to `FakeXHR.server`. */
class FakeXHR {
  static requests: FakeXHR[] = [];
  static server: (xhr: FakeXHR) => void = () => {};
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = "";
  responseURL = "";
  aborted = false;
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.requests.push(this);
    queueMicrotask(() => FakeXHR.server(this));
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  /** Reports progress in two halves, then answers. */
  respond(status: number, body: unknown = { state: "pending" }) {
    const size = (this.body as Blob).size;
    this.upload.onprogress?.({ loaded: size / 2 });
    this.upload.onprogress?.({ loaded: size });
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseURL = `https://ry-mart.com${this.url}`;
    this.onload?.();
  }
}

describe("uploadImage", () => {
  const SRC = `blog/${UUID}.webp`;
  let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;

  const prepared = (): import("./images").PreparedImage => ({
    ext: "webp",
    width: 2048,
    height: 1365,
    variants: [480, 1024, 2048].map((width, i) => ({
      width,
      blob: new Blob([new Uint8Array([100, 300, 600][i]!)], { type: "image/webp" }),
    })),
    previewUrl: "blob:preview",
  });

  beforeEach(() => {
    fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({ id: UUID, src: SRC, widths: [480, 1024, 2048] }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchFn);
    FakeXHR.requests = [];
    FakeXHR.server = (xhr) => xhr.respond(200);
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  it("creates the image, then PUTs every variant, largest last, with progress", async () => {
    const image = prepared();
    const progress: number[] = [];
    const result = await images.uploadImage("draft-1", image, (f) => progress.push(f));
    expect(result).toEqual({ src: SRC, w: 2048, h: 1365 });

    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe("/api/admin/images");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      draftId: "draft-1",
      ext: "webp",
      width: 2048,
      height: 1365,
    });
    expect(new Headers(init?.headers).get("X-Admin")).toBe("1");

    expect(FakeXHR.requests.map((r) => [r.method, r.url, r.body])).toEqual(
      image.variants.map((v) => ["PUT", `/api/admin/images/${UUID}/${v.width}`, v.blob]),
    );
    for (const request of FakeXHR.requests) {
      expect(request.headers).toEqual({
        "X-Requested-With": "XMLHttpRequest",
        "X-Admin": "1",
        "Content-Type": "image/webp",
      });
    }
    expect(progress).toEqual([0, 0.05, 0.1, 0.1, 0.25, 0.4, 0.4, 0.7, 1, 1]);
    expect(images.previewFor(SRC)).toBe("blob:preview");
  });

  it("sends a GIF as image/gif", async () => {
    fetchFn.mockResolvedValueOnce(
      Response.json({ id: UUID, src: `blog/${UUID}.gif`, widths: [300] }, { status: 201 }),
    );
    const blob = new Blob([gif(300, 200)]);
    const gifImage = {
      ext: "gif" as const,
      width: 300,
      height: 200,
      variants: [{ width: 300, blob }],
      previewUrl: "blob:gif",
    };
    await images.uploadImage("draft-1", gifImage, () => {});
    expect(FakeXHR.requests.map((r) => [r.url, r.headers["Content-Type"]])).toEqual([
      [`/api/admin/images/${UUID}/300`, "image/gif"],
    ]);
  });

  it("marks the session expired on a 401 and stops", async () => {
    FakeXHR.server = (xhr) => xhr.respond(401, {});
    await expect(images.uploadImage("draft-1", prepared(), () => {})).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
    expect(api.isSessionExpired()).toBe(true);
    expect(FakeXHR.requests).toHaveLength(1);
  });

  it("treats a redirect to a sign-in page as an expired session", async () => {
    FakeXHR.server = (xhr) => {
      xhr.status = 200;
      xhr.responseURL = "https://ry-mart.com/cdn-cgi/access/login";
      xhr.onload?.();
    };
    await expect(images.uploadImage("draft-1", prepared(), () => {})).rejects.toMatchObject({
      status: 401,
    });
    expect(api.isSessionExpired()).toBe(true);
  });

  it("throws the server's message when a variant is refused", async () => {
    FakeXHR.server = (xhr) =>
      xhr.respond(415, { error: { code: "image_metadata", message: "The image has metadata." } });
    await expect(images.uploadImage("draft-1", prepared(), () => {})).rejects.toMatchObject({
      name: "ApiError",
      status: 415,
      code: "image_metadata",
      message: "The image has metadata.",
    });
    expect(FakeXHR.requests).toHaveLength(1);
    expect(api.isSessionExpired()).toBe(false);
    expect(images.previewFor(SRC)).toBeUndefined();
  });

  it("throws the server's message when the image can't be created", async () => {
    fetchFn.mockResolvedValueOnce(
      Response.json({ error: { code: "not_found", message: "No such draft." } }, { status: 404 }),
    );
    await expect(images.uploadImage("draft-1", prepared(), () => {})).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
      message: "No such draft.",
    });
    expect(FakeXHR.requests).toHaveLength(0);
  });

  it("reports a network failure as an ApiError with status 0", async () => {
    FakeXHR.server = (xhr) => xhr.onerror?.();
    await expect(images.uploadImage("draft-1", prepared(), () => {})).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
  });

  it("aborts the upload in flight", async () => {
    FakeXHR.server = () => {};
    const controller = new AbortController();
    const upload = images.uploadImage("draft-1", prepared(), () => {}, controller.signal);
    await vi.waitFor(() => expect(FakeXHR.requests).toHaveLength(1));
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXHR.requests[0]!.aborted).toBe(true);
    expect(FakeXHR.requests).toHaveLength(1);
  });
});

describe("markImagesPublished", () => {
  let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchFn = vi.fn<typeof fetch>(async () => Response.json({ published: 1 }));
    vi.stubGlobal("fetch", fetchFn);
  });

  it("does nothing for no images", async () => {
    await images.markImagesPublished([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts each key once, at most 200 per request", async () => {
    const srcs = Array.from({ length: 250 }, (_, i) => `blog/${UUID.slice(0, -3)}${i + 100}.webp`);
    await images.markImagesPublished([...srcs, srcs[0]!]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const bodies = fetchFn.mock.calls.map(([path, init]) => {
      expect(path).toBe("/api/admin/images/published");
      expect(init?.method).toBe("POST");
      return JSON.parse(init?.body as string) as { srcs: string[] };
    });
    expect(bodies.map((body) => body.srcs.length)).toEqual([200, 50]);
    expect(bodies.flatMap((body) => body.srcs)).toEqual(srcs);
  });

  it("throws the server's message on a refusal", async () => {
    fetchFn.mockResolvedValueOnce(
      Response.json({ error: { code: "invalid_srcs", message: "Bad keys." } }, { status: 422 }),
    );
    await expect(images.markImagesPublished([`blog/${UUID}.webp`])).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      message: "Bad keys.",
    });
  });
});
