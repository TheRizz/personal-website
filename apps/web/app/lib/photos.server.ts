import type { Photo } from "./photos";

// The D1 reads behind /photos, shared with the Worker's admin API (worker/photos.ts). Server only.

export interface PhotoRow {
  id: string;
  ext: Photo["ext"];
  width: number;
  height: number;
  caption: string;
  alt: string;
  created_at: number;
}

export const PHOTO_COLUMNS = "id, ext, width, height, caption, alt, created_at";

export const toPhoto = (row: PhotoRow): Photo => ({
  id: row.id,
  ext: row.ext,
  width: row.width,
  height: row.height,
  caption: row.caption,
  alt: row.alt,
  createdAt: row.created_at,
});

/** Every photo whose upload finished, newest first: what /photos shows. */
export async function listPhotos(db: D1Database): Promise<Photo[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PHOTO_COLUMNS} FROM photos WHERE state = 'ready' ORDER BY created_at DESC, id`,
    )
    .all<PhotoRow>();
  return results.map(toPhoto);
}
