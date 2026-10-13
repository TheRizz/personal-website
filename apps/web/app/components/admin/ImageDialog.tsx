import { FIGURE_SIZES, type FigureSize } from "@site/content-markdown";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { inputClass, primaryButton, secondaryButton } from "~/components/games/ui";
import { ApiError } from "~/lib/admin/drafts";
import { ImageError, forgetPreview, prepareImage, uploadImage } from "~/lib/admin/images";
import { SIZE_LABELS } from "./FigureView";

// "Add an image" (design doc §4.9.6): the picked file is converted and uploaded straight away,
// while the owner writes the alt text, which is required before the figure goes in.

/** The attributes of a new figure node. */
export interface NewFigure {
  src: string;
  alt: string;
  size: FigureSize;
  w: number;
  h: number;
}

type Upload =
  | { state: "preparing" }
  | { state: "uploading"; fraction: number }
  | { state: "done"; src: string; w: number; h: number }
  | { state: "failed"; message: string };

/** What to tell the owner about a failed upload: our message or the server's, never a stack. */
function failure(error: unknown): string {
  if (error instanceof ImageError || error instanceof ApiError) return error.message;
  return "Couldn't upload the image. Check your connection and try again.";
}

export function ImageDialog({
  file,
  draftId,
  onInsert,
  onClose,
}: {
  file: File;
  draftId: string;
  onInsert: (figure: NewFigure) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [upload, setUpload] = useState<Upload>({ state: "preparing" });
  const [preview, setPreview] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [size, setSize] = useState<FigureSize>("column");
  // Set on Insert, so closing knows whether the uploaded image is in the post.
  const inserted = useRef(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Converts and uploads the file; closing the dialog cancels whatever is still running.
  useEffect(() => {
    const controller = new AbortController();
    const insertedRef = inserted;
    let previewUrl: string | undefined;
    let uploadedSrc: string | undefined;
    const run = async () => {
      try {
        const prepared = await prepareImage(file);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(prepared.previewUrl);
          return;
        }
        previewUrl = prepared.previewUrl;
        setPreview(previewUrl);
        setUpload({ state: "uploading", fraction: 0 });
        const image = await uploadImage(
          draftId,
          prepared,
          (fraction) => setUpload({ state: "uploading", fraction }),
          controller.signal,
        );
        uploadedSrc = image.src;
        setUpload({ state: "done", ...image });
      } catch (error) {
        if (!controller.signal.aborted) setUpload({ state: "failed", message: failure(error) });
      }
    };
    void run();
    return () => {
      controller.abort();
      // An inserted image keeps its preview for the figure; otherwise nothing shows it again. An
      // upload that was never inserted is left to the daily clean-up.
      if (insertedRef.current) return;
      if (uploadedSrc) forgetPreview(uploadedSrc);
      else if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [file, draftId]);

  const ready = upload.state === "done" && alt.trim() !== "";

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl border border-line bg-bg p-6 text-fg backdrop:bg-black/50"
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (upload.state !== "done" || !alt.trim()) return;
          inserted.current = true;
          // Close first: nothing outside a modal dialog can take the focus while it is open.
          dialog.current?.close();
          onInsert({ src: upload.src, alt: alt.trim(), size, w: upload.w, h: upload.h });
        }}
      >
        <h2 id={`${id}-title`} className="text-xl font-bold">
          Add an image
        </h2>
        {preview && (
          <img
            src={preview}
            alt=""
            className="mx-auto max-h-56 w-auto max-w-full rounded-lg border border-line"
          />
        )}
        <UploadStatus upload={upload} />
        <div>
          <label htmlFor={`${id}-alt`} className="mb-1.5 block text-sm font-semibold">
            Alt text
          </label>
          <input
            id={`${id}-alt`}
            value={alt}
            onChange={(event) => setAlt(event.target.value)}
            required
            aria-describedby={`${id}-alt-hint`}
            className={inputClass}
          />
          <p id={`${id}-alt-hint`} className="mt-1.5 text-sm text-muted">
            Required. Describe what the image shows for people who can&apos;t see it.
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-size`} className="mb-1.5 block text-sm font-semibold">
            Size
          </label>
          <select
            id={`${id}-size`}
            value={size}
            onChange={(event) => setSize(event.target.value as FigureSize)}
            className={inputClass}
          >
            {FIGURE_SIZES.map((value) => (
              <option key={value} value={value}>
                {SIZE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" className={primaryButton} disabled={!ready}>
            Insert
          </button>
        </div>
      </form>
    </dialog>
  );
}

function UploadStatus({ upload }: { upload: Upload }) {
  const id = useId();
  if (upload.state === "failed") {
    return (
      <p
        role="alert"
        className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[0.95rem]"
      >
        {upload.message}
      </p>
    );
  }
  const text = {
    preparing: "Preparing the image…",
    uploading: "Uploading the image…",
    done: "Uploaded.",
  }[upload.state];
  return (
    <div className="space-y-2">
      <p
        id={id}
        role="status"
        className="flex items-center gap-1.5 text-sm text-muted [&_svg]:size-4"
      >
        {upload.state === "done" ? (
          <Check aria-hidden="true" />
        ) : (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        )}
        {text}
      </p>
      {upload.state !== "done" && (
        <progress
          aria-labelledby={id}
          value={upload.state === "uploading" ? upload.fraction : undefined}
          max={1}
          className="h-2 w-full accent-fg"
        />
      )}
    </div>
  );
}
