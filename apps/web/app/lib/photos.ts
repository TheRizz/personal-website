import { PHOTOS_ORIGIN, figureWidths, variantKey } from "@site/content-markdown/figure";

// The Photos page's data, shared by the Worker (photos.ts), the admin page and /photos. A photo is
// stored like an editor image (design doc §4.9.6), under photos/ instead of blog/: every variant
// width up to 2048 px, `photos/<id>-<width>.<ext>`, or `photos/<id>.gif` once for a GIF.

/** The longest caption, in characters. */
export const MAX_CAPTION_LENGTH = 500;
/** The longest alt text, in characters. */
export const MAX_ALT_LENGTH = 300;

/** A photo as /photos and the admin page see it. */
export interface Photo {
  id: string;
  ext: "webp" | "jpg" | "gif";
  /** Size of the largest variant. */
  width: number;
  height: number;
  /** Plain text, shown under the photo; empty for none. */
  caption: string;
  /** Plain text for screen readers; empty falls back to the caption. */
  alt: string;
  createdAt: number;
}

/** The logical key of a photo, `photos/<id>.<ext>`, from which every variant key is made. */
export const photoSrc = (photo: Pick<Photo, "id" | "ext">) => `photos/${photo.id}.${photo.ext}`;

/** The widths stored for a photo, smallest first. */
export const photoWidths = (photo: Pick<Photo, "id" | "ext" | "width">) =>
  figureWidths(photoSrc(photo), photo.width);

/** The R2 key of one variant. */
export const photoKey = (photo: Pick<Photo, "id" | "ext">, width: number) =>
  variantKey(photoSrc(photo), width);

/** The public URL of one variant. */
export const photoUrl = (photo: Pick<Photo, "id" | "ext">, width: number) =>
  `${PHOTOS_ORIGIN}/${photoKey(photo, width)}`;

/** `src` and `srcSet` for an `<img>` of the photo; `src` is the variant nearest `fallback` px. */
export function photoImage(photo: Pick<Photo, "id" | "ext" | "width">, fallback = 1024) {
  const widths = photoWidths(photo);
  const src = photoUrl(photo, widths.filter((width) => width <= fallback).at(-1) ?? photo.width);
  if (widths.length === 1) return { src };
  return { src, srcSet: widths.map((width) => `${photoUrl(photo, width)} ${width}w`).join(", ") };
}

/** Alt text for a photo: its own, else its caption, else a plain label. */
export const photoAlt = (photo: Pick<Photo, "alt" | "caption">) =>
  photo.alt.trim() || photo.caption.trim() || "Photo";

/** A caption or alt text as stored: line breaks and runs of spaces collapsed, trimmed. */
export const cleanText = (text: string) => text.replace(/\s+/g, " ").trim();
