import type { Photo } from "../photos";
import { adminFetch } from "./api";
import { putVariant, refusal, type PreparedImage } from "./images";

// Typed calls to the photos API (worker/photos.ts). Every request goes through adminFetch, or
// putVariant for the bytes, so the owner gate sees the headers it needs.

const CONTENT_TYPES: Record<PreparedImage["ext"], string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  gif: "image/gif",
};

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw refusal(response.status, await response.text().catch(() => ""));
  return (await response.json()) as T;
}

/** Every photo on /photos, newest first. */
export async function listAdminPhotos(): Promise<Photo[]> {
  const { photos } = await json<{ photos: Photo[] }>(await adminFetch("/api/admin/photos"));
  return photos;
}

/**
 * Uploads a prepared image as a new photo with its caption and alt text: creates the row, then
 * PUTs each variant, smallest first. The photo is on /photos once the last one is stored.
 * `onProgress` gets the fraction of bytes sent.
 */
export async function uploadPhoto(
  prepared: PreparedImage,
  text: { caption: string; alt: string },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { ext, width, height } = prepared;
  const created = await json<{ id: string; widths: number[] }>(
    await adminFetch("/api/admin/photos", {
      method: "POST",
      body: JSON.stringify({ ext, width, height, ...text }),
      signal,
    }),
  );
  const uploads = [...created.widths]
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
      `/api/admin/photos/${created.id}/${variant.width}`,
      variant.blob,
      CONTENT_TYPES[ext],
      (loaded) => onProgress(Math.min(1, (sent + loaded) / total)),
      signal,
    );
    sent += variant.blob.size;
    onProgress(Math.min(1, sent / total));
  }
  return created.id;
}

/** Changes a photo's caption and alt text. Returns the photo as stored. */
export async function updatePhoto(
  id: string,
  text: { caption: string; alt: string },
): Promise<Photo> {
  return json<Photo>(
    await adminFetch(`/api/admin/photos/${id}`, { method: "PATCH", body: JSON.stringify(text) }),
  );
}

/** Deletes a photo and its files. */
export async function deletePhoto(id: string): Promise<void> {
  const response = await adminFetch(`/api/admin/photos/${id}`, { method: "DELETE" });
  if (!response.ok) throw refusal(response.status, await response.text().catch(() => ""));
}
