import { LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { inputClass, primaryButton, secondaryButton } from "~/components/games/ui";
import type { ErrorText } from "~/lib/admin/publish";
import { MAX_SLUG_LENGTH, isSlug, postUrl } from "~/lib/publish/post-path";

// The confirm dialogs for publishing (design doc §4.9.7, contract §10.2): publish, close the pull
// request, and unpublish. Each is a modal <dialog>: focus moves into it, starts on the choice that
// changes nothing (or on the address field, when there is one), and goes back to the button that
// opened it when it closes (or to a fallback, when that button left the page with it). Kept free of
// the Markdown pipeline, so /admin can show the unpublish dialog without loading the editor.

/** A refused request, with every line the server gave and a link to the draft it names. */
export function ErrorMessage({ error, onDismiss }: { error: ErrorText; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[0.95rem]"
    >
      <p>
        {error.text}
        {error.draftId && (
          <>
            {" "}
            <Link to={`/admin/drafts/${error.draftId}`} className="link font-semibold">
              Open that draft
            </Link>
          </>
        )}
      </p>
      {error.lines && error.lines.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 [overflow-wrap:anywhere]">
          {error.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {onDismiss && (
        <button type="button" className="link mt-1 text-sm text-muted" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Moves focus back to the dialog's opener if it is still on the page, else to `fallback`. */
export function restoreFocus(opener: HTMLElement | null, fallback: HTMLElement | null | undefined) {
  if (opener?.isConnected) opener.focus();
  else fallback?.focus();
}

/**
 * A modal confirm dialog. `onClose` runs on Escape and on the cancel button; neither works while
 * `busy`, so an answer can't arrive after the dialog is gone.
 */
function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel,
  busy,
  busyText,
  error,
  canConfirm = true,
  initialFocus,
  fallbackFocus,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  /** Announced while the request runs. */
  busyText: string;
  error: ErrorText | null;
  canConfirm?: boolean;
  /** Where focus starts; the cancel button when not given. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the button that opened the dialog has left the page. */
  fallbackFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallback = fallbackFocus?.current;
    if (!node.open) node.showModal();
    (initialFocus?.current ?? cancel.current)?.focus();
    // Removing the dialog takes it out of the top layer; close() here would fire `close` late and
    // shut it again after React's development remount.
    return () => restoreFocus(opener, fallback);
  }, [initialFocus, fallbackFocus]);

  // The buttons were disabled while the request ran, which drops the focus: after a refusal it
  // goes back to where the owner can act on it (the address field, else the cancel button).
  useEffect(() => {
    if (error) (initialFocus?.current ?? cancel.current)?.focus();
  }, [error, initialFocus]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="m-auto w-[min(34rem,calc(100%-2rem))] rounded-xl border border-line bg-bg p-6 text-fg backdrop:bg-black/50"
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && canConfirm) onConfirm();
        }}
      >
        <h2 id={`${id}-title`} className="text-xl font-bold">
          {title}
        </h2>
        <div id={`${id}-body`} className="space-y-3 text-[0.95rem] leading-relaxed">
          {children}
        </div>
        {error && <ErrorMessage error={error} />}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Always on the page, so the busy text is announced when it appears. */}
          <p role="status" className="mr-auto flex items-center gap-1.5 text-sm text-muted">
            {busy && (
              <>
                <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                {busyText}
              </>
            )}
          </p>
          <button
            ref={cancel}
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            {cancelLabel}
          </button>
          <button type="submit" className={primaryButton} disabled={busy || !canConfirm}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * "Publish this post?" with the exposure warning. While the draft has no slug it also asks for
 * the address, prefilled from the title; once a PR has been opened the slug is fixed.
 */
export function PublishDialog({
  slug,
  suggestedSlug,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  /** The draft's slug, or null when the owner picks it here. */
  slug: string | null;
  suggestedSlug: string;
  busy: boolean;
  error: ErrorText | null;
  /** Called with the chosen slug, or with nothing when the draft already has one. */
  onConfirm: (slug?: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(suggestedSlug);
  const chosen = slug ?? address.trim();
  const valid = isSlug(chosen);
  return (
    <ConfirmDialog
      title="Publish this post?"
      confirmLabel="Publish now"
      cancelLabel="Keep editing"
      busy={busy}
      busyText="Sending the post to GitHub…"
      error={error}
      canConfirm={valid}
      initialFocus={slug === null ? field : undefined}
      onConfirm={() => onConfirm(slug === null ? chosen : undefined)}
      onClose={onClose}
    >
      <p>
        Publishing makes this text public on a GitHub pull request now. It goes live about a minute
        after you merge that PR, and it stays in git history even if you cancel.
      </p>
      {slug === null && (
        <div>
          <label htmlFor={`${id}-address`} className="mb-1.5 block text-sm font-semibold">
            Address
          </label>
          <input
            ref={field}
            id={`${id}-address`}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            maxLength={MAX_SLUG_LENGTH}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!valid || undefined}
            aria-describedby={`${id}-address-hint`}
            className={`${inputClass} font-mono text-[0.95rem]`}
          />
          <p
            id={`${id}-address-hint`}
            className={`mt-1.5 text-sm ${valid ? "text-muted" : "text-red-700 dark:text-red-400"}`}
          >
            {valid
              ? "Fixed once the pull request is open."
              : "Use lowercase letters, digits and single dashes, at most 80 characters."}
          </p>
        </div>
      )}
      <p className="text-sm text-muted">
        It will be at{" "}
        <span className="font-mono text-fg [overflow-wrap:anywhere]">
          {postUrl(valid ? chosen : "…")}
        </span>
      </p>
    </ConfirmDialog>
  );
}

/** "Close the pull request?" for Cancel publish and Cancel unpublish. */
export function CancelPublishDialog({
  pr,
  action,
  busy,
  error,
  fallbackFocus,
  onConfirm,
  onClose,
}: {
  pr: number | null;
  action: "publish" | "unpublish" | null;
  busy: boolean;
  error: ErrorText | null;
  /** Where focus goes once the PR is closed, since the Cancel button goes with it. */
  fallbackFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title="Close the pull request?"
      confirmLabel="Close the PR"
      cancelLabel="Keep it open"
      busy={busy}
      busyText="Closing the pull request…"
      error={error}
      fallbackFocus={fallbackFocus}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>
        This closes {pr === null ? "the pull request" : `PR #${pr}`} on GitHub without merging it
        and deletes its branch.{" "}
        {action === "unpublish"
          ? "The post stays on the site."
          : "Nothing goes live, and the draft stays here. The PR and its text stay visible on GitHub."}
      </p>
    </ConfirmDialog>
  );
}

/** The unpublish warning on /admin: what the PR deletes and what it can't take back. */
export function UnpublishDialog({
  path,
  slug,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  path: string;
  slug: string;
  busy: boolean;
  error: ErrorText | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const code = "rounded bg-surface px-1 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]";
  return (
    <ConfirmDialog
      title="Unpublish this post?"
      confirmLabel="Open the unpublish PR"
      cancelLabel="Keep it published"
      busy={busy}
      busyText="Opening the pull request…"
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>
        Unpublishing opens a pull request that deletes <code className={code}>{path}</code>. The
        post leaves the site about a minute after you merge it, but it stays in public git history.
        To take it down right now, block <code className={code}>/blog/{slug}</code> with a WAF rule.
        Its images stay at photos.ry-mart.com; delete them in R2 and purge the cache if they must go
        too.
      </p>
    </ConfirmDialog>
  );
}
