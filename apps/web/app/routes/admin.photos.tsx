import { Check, ImagePlus, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { card, inputClass, primaryButton, secondaryButton } from "~/components/games/ui";
import { ApiError } from "~/lib/admin/drafts";
import { ImageError, prepareImage, type PreparedImage } from "~/lib/admin/images";
import { deletePhoto, listAdminPhotos, updatePhoto, uploadPhoto } from "~/lib/admin/photos";
import { adminMeta } from "~/lib/meta";
import {
  MAX_ALT_LENGTH,
  MAX_CAPTION_LENGTH,
  cleanText,
  photoAlt,
  photoImage,
  type Photo,
} from "~/lib/photos";
import type { Route } from "./+types/admin.photos";

// The Photos page's admin (/photos): add a photo with an optional caption, change a caption, or
// delete a photo. A saved photo is public at once. Built for a phone: one file input, plain
// buttons, no dragging. Like every admin page, it has no loader; the data comes from /api/admin.

export const meta: Route.MetaFunction = () => adminMeta("Photos");

/** What to tell the owner about a failure: our message or the server's, never a stack. */
function failure(error: unknown, fallback: string): string {
  if (error instanceof ImageError || error instanceof ApiError) return error.message;
  return fallback;
}

export default function AdminPhotos() {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listAdminPhotos()
      .then((list) => !cancelled && setPhotos(list))
      .catch(
        () =>
          !cancelled && setError("Couldn't load your photos. Check your connection and reload."),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <p className="mb-6 text-sm">
        <Link to="/admin" className="link">
          ← Drafts
        </Link>
      </p>
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <PageHeading title="Photos">
          {/* A full page load: the public page isn't part of the admin app. */}
          What shows on{" "}
          <a href="/photos" className="link">
            your Photos page
          </a>
          . A photo you save is public straight away.
        </PageHeading>
        <button
          type="button"
          className={primaryButton}
          disabled={file !== null}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus aria-hidden="true" />
          Add photo
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const picked = event.currentTarget.files?.[0];
            // Picking the same file again should open the form again.
            event.currentTarget.value = "";
            if (picked) setFile(picked);
          }}
        />
      </div>
      {file && (
        <NewPhoto
          file={file}
          onSaved={(photo) => {
            setPhotos((list) => [photo, ...(list ?? [])]);
            setFile(null);
          }}
          onCancel={() => setFile(null)}
        />
      )}
      {error && (
        <p
          role="alert"
          className="mb-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3"
        >
          {error}
        </p>
      )}
      {photos === null && !error && <p className="text-muted">Loading…</p>}
      {photos?.length === 0 && !file && (
        <p className="text-muted">No photos yet. Tap Add photo to upload your first one.</p>
      )}
      {photos && photos.length > 0 && (
        <ul aria-label="Your photos" className="space-y-4">
          {photos.map((photo) => (
            <PhotoItem
              key={photo.id}
              photo={photo}
              onChange={(next) =>
                setPhotos((list) => list?.map((p) => (p.id === next.id ? next : p)) ?? null)
              }
              onDelete={() => setPhotos((list) => list?.filter((p) => p.id !== photo.id) ?? null)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** The caption and alt fields, shared by a new photo and an existing one. */
function TextFields({
  caption,
  alt,
  onCaption,
  onAlt,
}: {
  caption: string;
  alt: string;
  onCaption: (value: string) => void;
  onAlt: (value: string) => void;
}) {
  const id = useId();
  return (
    <>
      <div>
        <label htmlFor={`${id}-caption`} className="mb-1.5 block text-sm font-semibold">
          Caption (optional)
        </label>
        <textarea
          id={`${id}-caption`}
          value={caption}
          maxLength={MAX_CAPTION_LENGTH}
          rows={2}
          onChange={(event) => onCaption(event.target.value)}
          aria-describedby={`${id}-caption-hint`}
          className={inputClass}
        />
        <p id={`${id}-caption-hint`} className="mt-1.5 text-sm text-muted">
          Shows under the photo.
        </p>
      </div>
      <div>
        <label htmlFor={`${id}-alt`} className="mb-1.5 block text-sm font-semibold">
          Description for screen readers (optional)
        </label>
        <input
          id={`${id}-alt`}
          value={alt}
          maxLength={MAX_ALT_LENGTH}
          onChange={(event) => onAlt(event.target.value)}
          aria-describedby={`${id}-alt-hint`}
          className={inputClass}
        />
        <p id={`${id}-alt-hint`} className="mt-1.5 text-sm text-muted">
          What the photo shows, for people who can&apos;t see it. Left empty, the caption is used.
        </p>
      </div>
    </>
  );
}

type Upload =
  | { state: "preparing" }
  | { state: "prepared"; image: PreparedImage }
  | { state: "uploading"; image: PreparedImage; fraction: number }
  | { state: "failed"; image?: PreparedImage; message: string };

/** The form for a picked file: the photo is converted at once, and uploaded on Save. */
function NewPhoto({
  file,
  onSaved,
  onCancel,
}: {
  file: File;
  onSaved: (photo: Photo) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [upload, setUpload] = useState<Upload>({ state: "preparing" });
  const [caption, setCaption] = useState("");
  const [alt, setAlt] = useState("");
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let previewUrl: string | undefined;
    prepareImage(file)
      .then((image) => {
        previewUrl = image.previewUrl;
        if (cancelled) URL.revokeObjectURL(previewUrl);
        else setUpload({ state: "prepared", image });
      })
      .catch(
        (error: unknown) =>
          !cancelled &&
          setUpload({ state: "failed", message: failure(error, "Couldn't read this image.") }),
      );
    return () => {
      cancelled = true;
      abort.current?.abort();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [file]);

  const image = upload.state === "preparing" ? undefined : upload.image;
  const save = async () => {
    if (!image) return;
    const controller = new AbortController();
    abort.current = controller;
    const text = { caption: cleanText(caption), alt: cleanText(alt) };
    setUpload({ state: "uploading", image, fraction: 0 });
    try {
      const photoId = await uploadPhoto(
        image,
        text,
        (fraction) => setUpload({ state: "uploading", image, fraction }),
        controller.signal,
      );
      onSaved({
        id: photoId,
        ext: image.ext,
        width: image.width,
        height: image.height,
        ...text,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setUpload({
        state: "failed",
        image,
        message: failure(error, "Couldn't upload the photo. Check your connection and try again."),
      });
    }
  };

  const uploading = upload.state === "uploading";
  return (
    <section aria-labelledby={`${id}-title`} className={`${card} mb-8`}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`} className="text-xl font-bold">
          New photo
        </h2>
        {image && (
          <img
            src={image.previewUrl}
            alt=""
            className="mx-auto max-h-72 w-auto max-w-full rounded-lg border border-line"
          />
        )}
        {upload.state === "preparing" && <Status text="Preparing the photo…" />}
        {upload.state === "uploading" && (
          <div className="space-y-2">
            <Status text="Uploading…" />
            <progress value={upload.fraction} max={1} className="h-2 w-full accent-fg" />
          </div>
        )}
        {upload.state === "failed" && (
          <p
            role="alert"
            className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[0.95rem]"
          >
            {upload.message}
          </p>
        )}
        <TextFields caption={caption} alt={alt} onCaption={setCaption} onAlt={setAlt} />
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={primaryButton} disabled={!image || uploading}>
            {upload.state === "failed" && image ? "Try again" : "Save photo"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Status({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-sm text-muted [&_svg]:size-4">
      <LoaderCircle aria-hidden="true" className="animate-spin" />
      {text}
    </p>
  );
}

/** One saved photo: its caption and alt text can be changed, and it can be deleted. */
function PhotoItem({
  photo,
  onChange,
  onDelete,
}: {
  photo: Photo;
  onChange: (photo: Photo) => void;
  onDelete: () => void;
}) {
  const [caption, setCaption] = useState(photo.caption);
  const [alt, setAlt] = useState(photo.alt);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { src, srcSet } = photoImage(photo, 480);
  const changed = cleanText(caption) !== photo.caption || cleanText(alt) !== photo.alt;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await updatePhoto(photo.id, {
        caption: cleanText(caption),
        alt: cleanText(alt),
      });
      setCaption(next.caption);
      setAlt(next.alt);
      onChange(next);
      setSaved(true);
    } catch (failed) {
      setError(failure(failed, "Couldn't save. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Delete this photo? It comes off your Photos page.")) return;
    setBusy(true);
    setError(null);
    try {
      await deletePhoto(photo.id);
      onDelete();
    } catch (failed) {
      setError(failure(failed, "Couldn't delete. Check your connection and try again."));
      setBusy(false);
    }
  };

  return (
    <li className={`${card} grid gap-4 sm:grid-cols-[12rem_1fr]`}>
      <img
        src={src}
        srcSet={srcSet}
        sizes="(min-width: 40rem) 12rem, 100vw"
        width={photo.width}
        height={photo.height}
        alt={photoAlt(photo)}
        loading="lazy"
        className="h-auto w-full rounded-lg border border-line"
      />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextFields
          caption={caption}
          alt={alt}
          onCaption={(value) => {
            setCaption(value);
            setSaved(false);
          }}
          onAlt={(value) => {
            setAlt(value);
            setSaved(false);
          }}
        />
        {error && (
          <p role="alert" className="text-[0.95rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {saved && !changed && (
            <p role="status" className="mr-auto flex items-center gap-1 text-sm text-muted">
              <Check aria-hidden="true" className="size-4" />
              Saved
            </p>
          )}
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </button>
          <button type="submit" className={primaryButton} disabled={busy || !changed}>
            Save
          </button>
        </div>
      </form>
    </li>
  );
}
