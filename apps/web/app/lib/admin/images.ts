import { FIGURE_SRC, MAX_FIGURE_WIDTH, figureWidths } from "@site/content-markdown";
import { adminFetch, markSessionExpired } from "./api";
import { ApiError } from "./drafts";

// Image uploads for the editor (design doc §4.9.6). The browser re-encodes every image except a
// GIF: createImageBitmap applies the EXIF rotation, a canvas scales it to each variant width and
// encodes WebP, or JPEG where the browser can't encode WebP (Safari). Re-encoding keeps only the
// pixels, so EXIF and GPS data never leave the device. The Worker sniffs and checks every upload
// again, so this file is not the only control.

/** The Worker refuses any single upload larger than this. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Enough of a file to recognise its type, including an SVG's XML prologue. */
const SNIFF_BYTES = 4096;

/** Most image keys one request may mark published. */
const PUBLISHED_BATCH = 200;

const CONVERT_FAILED = "This browser couldn't convert the image. Try another browser.";

export type SniffedType = "jpg" | "png" | "gif" | "webp" | "svg" | "avif";

/** An image ready to upload: every variant the Worker will ask for, smallest first. */
export interface PreparedImage {
  ext: "webp" | "jpg" | "gif";
  /** Size of the largest variant. */
  width: number;
  height: number;
  variants: { width: number; blob: Blob }[];
  /** A blob: URL of the largest variant, for the preview. */
  previewUrl: string;
}

/** A file that can't be used as an image, with a message to show the owner. */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

const CONTENT_TYPES: Record<PreparedImage["ext"], string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  gif: "image/gif",
};

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/** An ISO media file (`ftyp` box) whose major or compatible brands include AVIF. */
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !startsWith(bytes, ascii("ftyp"), 4)) return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  const end = Math.min(boxSize, bytes.length);
  const avifBrand = (offset: number) =>
    startsWith(bytes, ascii("avif"), offset) || startsWith(bytes, ascii("avis"), offset);
  // The major brand at 8, a minor version at 12, then compatible brands to the end of the box.
  if (avifBrand(8)) return true;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (avifBrand(offset)) return true;
  }
  return false;
}

/** Markup that starts with a tag and has an `<svg` element near the top. */
function isSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes.subarray(0, SNIFF_BYTES)).trimStart();
  return text.startsWith("<") && /<svg[\s>/]/i.test(text);
}

/** The type of an image from its first bytes, never from its name or claimed type. */
export function sniffImage(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  if (isAvif(bytes)) return "avif";
  if (isSvg(bytes)) return "svg";
  return null;
}

/** A GIF's size from its logical screen descriptor, or null if the header is cut short. */
export function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 10);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** An image's size scaled down to at most `maxWidth` wide, keeping its aspect. Never upscales. */
export function targetSize(
  width: number,
  height: number,
  maxWidth = MAX_FIGURE_WIDTH,
): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

/**
 * Reads a file the owner picked and makes the variants to upload. A GIF (by its bytes) is used as
 * it is; SVG and AVIF are refused; anything else the browser can open is re-encoded. Throws an
 * `ImageError` with a message for the owner when the file can't be used.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const type = sniffImage(head);
  if (type === "svg") {
    throw new ImageError("SVG images aren't supported. Export it as a PNG or JPEG first.");
  }
  if (type === "avif") {
    throw new ImageError("AVIF images aren't supported. Use a JPEG, PNG or WebP instead.");
  }
  if (type === "gif") return prepareGif(file, head);
  return reencode(file);
}

function prepareGif(file: File, head: Uint8Array): PreparedImage {
  const size = gifSize(head);
  if (!size) throw new ImageError("This GIF looks damaged. Try saving it again.");
  if (size.width > MAX_FIGURE_WIDTH) {
    throw new ImageError(
      `This GIF is ${size.width} pixels wide. GIFs are uploaded as they are, so resize it to ` +
        `${MAX_FIGURE_WIDTH} pixels or less first.`,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ImageError("This GIF is larger than 10 MB. Make it smaller or shorter first.");
  }
  return {
    ext: "gif",
    ...size,
    variants: [{ width: size.width, blob: file }],
    previewUrl: URL.createObjectURL(file),
  };
}

interface Format {
  ext: "webp" | "jpg";
  type: string;
  quality: number;
}

// Safari can't encode WebP from a canvas and returns a PNG instead, so it gets JPEG. The design
// also allows encoding WebP with @jsquash/webp there; that is deferred to keep dependencies out.
const WEBP: Format = { ext: "webp", type: "image/webp", quality: 0.8 };
const JPEG: Format = { ext: "jpg", type: "image/jpeg", quality: 0.82 };

async function reencode(file: File): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError("This file isn't an image the browser can open. Try a JPEG, PNG or WebP.");
  }
  try {
    const { width, height } = targetSize(bitmap.width, bitmap.height);
    let format = WEBP;
    const variants: PreparedImage["variants"] = [];
    for (const variantWidth of figureWidths("blog/x.webp", width)) {
      const size = targetSize(bitmap.width, bitmap.height, variantWidth);
      let blob = await encode(bitmap, size, format);
      // Only the first variant can switch the format, so every variant shares one.
      if (blob.type !== format.type && variants.length === 0) {
        format = JPEG;
        blob = await encode(bitmap, size, format);
      }
      if (blob.type !== format.type) throw new ImageError(CONVERT_FAILED);
      if (format === JPEG) {
        const stripped = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));
        if (!stripped) throw new ImageError(CONVERT_FAILED);
        blob = new Blob([stripped], { type: JPEG.type });
      }
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new ImageError("This image is still larger than 10 MB after resizing.");
      }
      variants.push({ width: variantWidth, blob });
    }
    const largest = variants.at(-1)!;
    return {
      ext: format.ext,
      width,
      height,
      variants,
      previewUrl: URL.createObjectURL(largest.blob),
    };
  } finally {
    bitmap.close();
  }
}

/** JPEG segments a canvas may write that hold nothing but pixels' metadata. */
const KEPT_JPEG_APPS = new Set([
  0xe0, // JFIF
  0xe2, // ICC colour profile
  0xee, // Adobe colour transform
]);

/**
 * A canvas JPEG without its APP segments other than JFIF, ICC and Adobe. Safari encodes through
 * ImageIO, which adds an EXIF block (only the size and colour space) and an empty Photoshop
 * block; the Worker refuses both, so they go before upload. Returns null for a broken file.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  for (;;) {
    if (bytes[at] !== 0xff) return null;
    let marker = at + 1;
    while (bytes[marker] === 0xff) marker++;
    const type = bytes[marker];
    if (type === undefined) return null;
    // Start of scan: everything from here on is image data and the segments between scans,
    // which a canvas doesn't fill with metadata.
    if (type === 0xda || type === 0xd9) {
      kept.push(bytes.subarray(at));
      break;
    }
    const length = ((bytes[marker + 1] ?? 0) << 8) | (bytes[marker + 2] ?? 0);
    const end = marker + 1 + length;
    if (length < 2 || end > bytes.length) return null;
    const isApp = type >= 0xe0 && type <= 0xef;
    if (!isApp || KEPT_JPEG_APPS.has(type)) kept.push(bytes.subarray(at, end));
    at = end;
  }
  const result = new Uint8Array(kept.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of kept) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Draws the bitmap at `size` on a canvas and encodes it. */
async function encode(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  format: Format,
): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(size.width, size.height);
    draw(canvas.getContext("2d"), bitmap, size, format);
    return canvas.convertToBlob({ type: format.type, quality: format.quality }).catch(() => {
      throw new ImageError(CONVERT_FAILED);
    });
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  draw(canvas.getContext("2d"), bitmap, size, format);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageError(CONVERT_FAILED))),
      format.type,
      format.quality,
    );
  });
}

function draw(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null,
  bitmap: ImageBitmap,
  { width, height }: { width: number; height: number },
  format: Format,
) {
  if (!context) throw new ImageError(CONVERT_FAILED);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // JPEG has no transparency, and a transparent pixel would otherwise turn black.
  if (format.ext === "jpg") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
}

/** The error for a refused request, with the server's message when it sent one. */
export function refusal(status: number, body: string): ApiError {
  let error: { code?: string; message?: string } | undefined;
  try {
    error = (JSON.parse(body) as { error?: typeof error }).error;
  } catch {
    // Not JSON (an Access page, say): use the generic message below.
  }
  return new ApiError(
    status,
    error?.code ?? "error",
    error?.message ?? `Request failed (${status}).`,
  );
}

/** PUTs one variant with XMLHttpRequest, since fetch() can't report upload progress. */
export function putVariant(
  path: string,
  blob: Blob,
  contentType: string,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = (error?: unknown) => {
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", path);
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
    xhr.setRequestHeader("X-Admin", "1");
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      // XMLHttpRequest follows redirects, and one here would be Access sending us to sign in.
      const redirected = Boolean(xhr.responseURL) && !xhr.responseURL.endsWith(path);
      if (xhr.status === 401 || redirected) {
        markSessionExpired();
        settle(new ApiError(401, "unauthorized", "Your session expired. Reload to sign in again."));
      } else if (xhr.status >= 200 && xhr.status < 300) {
        settle();
      } else {
        settle(refusal(xhr.status, xhr.responseText));
      }
    };
    xhr.onerror = () =>
      settle(new ApiError(0, "network", "The upload failed. Check the connection and try again."));
    xhr.onabort = () =>
      settle(signal?.reason ?? new DOMException("Upload cancelled", "AbortError"));
    xhr.send(blob);
  });
}

/**
 * Uploads a prepared image to a draft: creates the image, then PUTs each variant the Worker asks
 * for, largest last. `onProgress` gets the fraction of bytes sent across all variants. A refusal
 * throws an `ApiError` with the server's message (status 0 when the network failed), and a 401
 * marks the session expired. On success the preview is remembered for the returned `src`.
 */
export async function uploadImage(
  draftId: string,
  prepared: PreparedImage,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ src: string; w: number; h: number }> {
  const { ext, width, height } = prepared;
  const response = await adminFetch("/api/admin/images", {
    method: "POST",
    body: JSON.stringify({ draftId, ext, width, height }),
    signal,
  });
  if (!response.ok) throw refusal(response.status, await response.text().catch(() => ""));
  const image = (await response.json()) as { id: string; src: string; widths: number[] };
  if (!FIGURE_SRC.test(image.src)) throw new Error("The server returned an invalid image key");
  const uploads = [...image.widths]
    .sort((a, b) => a - b)
    .map((variantWidth) => {
      const variant = prepared.variants.find((v) => v.width === variantWidth);
      if (!variant) throw new Error(`No ${variantWidth} px variant to upload`);
      return variant;
    });
  const total = uploads.reduce((sum, variant) => sum + variant.blob.size, 0) || 1;
  let sent = 0;
  onProgress(0);
  for (const variant of uploads) {
    await putVariant(
      `/api/admin/images/${image.id}/${variant.width}`,
      variant.blob,
      CONTENT_TYPES[ext],
      (loaded) => onProgress(Math.min(1, (sent + loaded) / total)),
      signal,
    );
    sent += variant.blob.size;
    onProgress(Math.min(1, sent / total));
  }
  rememberPreview(image.src, prepared.previewUrl);
  return { src: image.src, w: width, h: height };
}

/**
 * Marks images published, so discarding the draft or the clean-up never deletes them. Called when
 * the post's Markdown is downloaded or copied, since that file may be committed by hand.
 */
export async function markImagesPublished(srcs: string[]): Promise<void> {
  const unique = [...new Set(srcs)];
  for (let start = 0; start < unique.length; start += PUBLISHED_BATCH) {
    const response = await adminFetch("/api/admin/images/published", {
      method: "POST",
      body: JSON.stringify({ srcs: unique.slice(start, start + PUBLISHED_BATCH) }),
    });
    if (!response.ok) throw refusal(response.status, await response.text().catch(() => ""));
  }
}

const SRC_ATTRIBUTE = /\bsrc\s*=\s*["']?(blog\/[^"'\s}]+)/g;

/**
 * Every image key in the `::figure` lines of a Markdown body, once each. It errs towards finding
 * too many (a figure line in a code block, say): that only keeps an extra image, while missing one
 * could let the clean-up delete an image a committed file still uses.
 */
export function figureSrcs(markdown: string): string[] {
  const srcs = new Set<string>();
  for (const line of markdown.split("\n")) {
    if (!line.includes("::figure")) continue;
    for (const [, src] of line.matchAll(SRC_ATTRIBUTE)) {
      if (src && FIGURE_SRC.test(src)) srcs.add(src);
    }
  }
  return [...srcs];
}

// blob: URLs of images uploaded in this tab, so a new figure shows before the photos CDN has it.
const previews = new Map<string, string>();

/** Remembers a local preview URL for an image key. */
export function rememberPreview(src: string, url: string): void {
  previews.set(src, url);
}

/** Lets a preview go, when its image never made it into the post. */
export function forgetPreview(src: string): void {
  const url = previews.get(src);
  if (url) URL.revokeObjectURL(url);
  previews.delete(src);
}

/** The local preview URL for an image key uploaded in this tab, if any. */
export function previewFor(src: string): string | undefined {
  return previews.get(src);
}
