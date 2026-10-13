import { MarkdownError, renderMarkdown } from "@site/content-markdown";
import { AlertTriangle, GitPullRequestClosed, RefreshCw, Send, Wrench } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { card, ghostButton, secondaryButton } from "~/components/games/ui";
import type { Autosaver } from "~/lib/admin/autosave";
import { ApiError, getDraft, type DraftFields } from "~/lib/admin/drafts";
import { localDate, postFile, slugify } from "~/lib/admin/post-file";
import {
  MERGED_OTHER_VERSION,
  PR_NOT_UPDATED,
  cancelPublish,
  describePublishError,
  fileDates,
  getPublishState,
  importPost,
  isOpenStage,
  isTerminal,
  metaOf,
  publishButton,
  publishDraft,
  stageText,
  type DraftMeta,
  type ErrorText,
  type PublishState,
} from "~/lib/admin/publish";
import { createPublishPoller, type PublishPoller } from "~/lib/admin/publish-poller";
import { CancelPublishDialog, ErrorMessage, PublishDialog } from "./PublishDialog";
import { PublishTimeline, hasTimeline } from "./PublishTimeline";

// Publishing from the editor (design doc §4.9.7, contract §10.2): the toolbar's Publish button,
// the confirm dialog, the status timeline that polls every 10 s, Cancel, and "Load the GitHub
// version" when the post changed on `main`. `usePublishing` holds the state; `PublishButton` and
// `PublishPanel` show it in the toolbar and under it.

type Busy = "checking" | "publishing" | "cancelling" | "loading";

export interface PublishingOptions {
  id: string;
  /** The draft's status when the editor loaded it; `publishing` and `failed` start polling. */
  initialStatus: string;
  meta: DraftMeta;
  onMeta: (meta: DraftMeta) => void;
  saver: Autosaver;
  fields: DraftFields;
  cover: string | null;
  /** The editor's reload: the draft from the server replaces what is on screen. */
  reload: () => Promise<void>;
  /** Moves the focus to the post body ("Fix and republish"). */
  focusBody: () => void;
}

export type Publishing = ReturnType<typeof usePublishing>;

/** What can stop a publish before the dialog: the browser's own frontmatter and Markdown checks. */
async function checkPost(meta: DraftMeta, fields: DraftFields, cover: string | null) {
  const { date, updated } = fileDates(meta);
  const file = postFile({ ...fields, slug: meta.slug, cover }, date, updated ? { updated } : {});
  const errors = file.ok ? [] : [...file.errors];
  try {
    await renderMarkdown(fields.bodyMd);
  } catch (error) {
    errors.push(error instanceof MarkdownError ? error.message : "The body can't be rendered.");
  }
  return errors;
}

/** Why a publish can't start while autosave hasn't stored the latest version. */
function unsavedText(status: Autosaver["current"]["status"]): string {
  return status === "conflict"
    ? "This draft was saved in another tab. Load that version or keep this one, then publish."
    : "Your latest changes aren't saved yet. Wait for Saved, or press Save, then publish.";
}

/** The publishing state of one draft in the editor, and what the owner can do with it. */
export function usePublishing({
  id,
  initialStatus,
  meta,
  onMeta,
  saver,
  fields,
  cover,
  reload,
  focusBody,
}: PublishingOptions) {
  const [state, setState] = useState<PublishState | null>(null);
  const [checking, setChecking] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<ErrorText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "This post changed on GitHub": offers to load the version on `main`.
  const [changed, setChanged] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"publish" | "cancel" | null>(null);
  const [dialogError, setDialogError] = useState<ErrorText | null>(null);
  const poller = useRef<PublishPoller | null>(null);

  /** Takes kind, slug, status, source path and post date from the server; never the content. */
  const refreshMeta = useCallback(() => {
    getDraft(id)
      .then((draft) => onMeta(metaOf(draft)))
      .catch(() => {
        // The next load of the page has them; the timeline already shows where the PR is.
      });
  }, [id, onMeta]);

  // Polls while the PR can still move: from the start when the draft is publishing or failed,
  // once for a published draft (its Live step), and after every publish.
  useEffect(() => {
    const instance = createPublishPoller({
      fetchState: () => getPublishState(id),
      isVisible: () => document.visibilityState !== "hidden",
      onVisibilityChange: (callback) => {
        document.addEventListener("visibilitychange", callback);
        return () => document.removeEventListener("visibilitychange", callback);
      },
      onState: (next) => {
        setState(next);
        setPollError(null);
        if (isTerminal(next.stage)) refreshMeta();
      },
      onError: (failure) =>
        setPollError(`Couldn't check the status. ${describePublishError(failure).text}`),
    });
    poller.current = instance;
    if (initialStatus === "publishing" || initialStatus === "failed") {
      instance.start();
      void instance.checkNow();
    } else if (initialStatus === "published") {
      void instance.checkNow();
    }
    return () => {
      instance.stop();
      poller.current = null;
    };
  }, [id, initialStatus, refreshMeta]);

  /** Checks now and keeps polling while the stage can change. */
  const refresh = async () => {
    const instance = poller.current;
    if (!instance) return;
    setChecking(true);
    instance.start();
    await instance.checkNow();
    setChecking(false);
  };

  /** Shows a state the API answered with, dropping any older poll still on its way. */
  const follow = (next: PublishState) => {
    poller.current?.stop();
    setState(next);
    setPollError(null);
    if (!isTerminal(next.stage)) poller.current?.start();
    refreshMeta();
  };

  /** Shows a refused request, and does what its code calls for (contract §10.2). */
  const fail = (failure: unknown) => {
    const text = describePublishError(failure);
    if (failure instanceof ApiError) {
      switch (failure.code) {
        case "stale_draft":
          void reload();
          break;
        case "changed_on_github":
          setChanged(text.text);
          return;
        case "branch_changed":
        case "pr_not_open":
        case "publishing":
        case "not_publishing":
        case "already_merged":
          void refresh();
          break;
      }
    }
    setError(text);
  };

  const clearMessages = () => {
    setError(null);
    setNotice(null);
  };

  const requestPublish = async () => {
    if (busy) return;
    clearMessages();
    setBusy("checking");
    try {
      await saver.flush();
      if (saver.current.status !== "saved") {
        setError({ text: unsavedText(saver.current.status) });
        return;
      }
      const errors = await checkPost(meta, fields, cover);
      if (errors.length > 0) {
        setError({ text: "Fix these before publishing:", lines: errors });
        return;
      }
      setDialogError(null);
      setDialog("publish");
    } finally {
      setBusy(null);
    }
  };

  const confirmPublish = async (slug?: string) => {
    setBusy("publishing");
    setDialogError(null);
    try {
      const result = await publishDraft(id, {
        baseRev: saver.current.rev,
        date: localDate(),
        ...(slug !== undefined && { slug }),
      });
      setDialog(null);
      follow(result);
      setNotice(
        result.warnings?.includes("pr_not_updated")
          ? PR_NOT_UPDATED
          : result.republished
            ? `Pushed your changes to PR #${result.pr}.`
            : null,
      );
    } catch (failure) {
      // A taken address is fixed in the dialog itself.
      if (slug !== undefined && failure instanceof ApiError && failure.code === "slug_taken") {
        setDialogError(describePublishError(failure));
        return;
      }
      setDialog(null);
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  const confirmCancel = async () => {
    setBusy("cancelling");
    setDialogError(null);
    try {
      follow(await cancelPublish(id));
      setDialog(null);
    } catch (failure) {
      setDialog(null);
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  /** Loads the version on `main` into this draft; the version it replaces stays in Revisions. */
  const loadGitHubVersion = async () => {
    if (busy || !meta.slug) return;
    clearMessages();
    setBusy("loading");
    try {
      await saver.flush();
      if (saver.current.status !== "saved") {
        setError({ text: unsavedText(saver.current.status) });
        return;
      }
      const result = await importPost(meta.slug, { baseRev: saver.current.rev });
      setChanged(null);
      // The reload brings the new kind and source path too.
      await reload();
      setNotice(
        result.converted
          ? "This draft is now a new post. Publishing it opens a Publish: PR."
          : "Loaded the GitHub version. The version it replaced is in Revisions, marked Replaced.",
      );
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  return {
    state,
    meta,
    button: publishButton(meta, state),
    checking,
    pollError,
    busy,
    error,
    notice,
    changed,
    dialog,
    dialogError,
    /** The address the dialog suggests while the draft has none. */
    suggestedSlug: slugify(fields.title),
    requestPublish,
    confirmPublish,
    requestCancel: () => {
      clearMessages();
      setDialogError(null);
      setDialog("cancel");
    },
    confirmCancel,
    closeDialog: () => setDialog(null),
    checkNow: refresh,
    loadGitHubVersion,
    fixAndRepublish: focusBody,
    dismissError: () => setError(null),
    dismissNotice: () => setNotice(null),
  };
}

const toolbarPrimary =
  "inline-flex items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-sm font-semibold text-bg transition duration-200 ease-spring hover:opacity-90 active:scale-95 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

/** The editor toolbar's Publish / Publish changes / Republish button. */
export function PublishButton({ publishing }: { publishing: Publishing }) {
  const hint = useId();
  const { label, blockedBy } = publishing.button;
  return (
    <>
      {blockedBy && (
        <span id={hint} className="text-sm text-muted">
          {blockedBy}
        </span>
      )}
      <button
        type="button"
        className={toolbarPrimary}
        // Not disabled while it checks: the dialog hands the focus back to this button.
        disabled={blockedBy !== null}
        aria-describedby={blockedBy ? hint : undefined}
        aria-busy={publishing.busy === "checking" || undefined}
        onClick={() => void publishing.requestPublish()}
      >
        <Send aria-hidden="true" />
        {label}
      </button>
    </>
  );
}

const alertBox = "rounded-xl border px-4 py-3 text-[0.95rem]";

/** Messages, the status timeline and its buttons, and the publishing dialogs. */
export function PublishPanel({ publishing }: { publishing: Publishing }) {
  const heading = useId();
  // A closed PR takes its Cancel button away, so focus goes here when the cancel dialog shuts.
  const checkNow = useRef<HTMLButtonElement>(null);
  const { state, meta, busy } = publishing;
  const open = state !== null && isOpenStage(state.stage);
  const showStatus = state !== null || meta.status !== "draft";
  return (
    <>
      {publishing.changed && (
        <div
          role="alert"
          className={`${alertBox} flex flex-wrap items-center gap-x-3 gap-y-2 border-amber-500/50 bg-amber-500/10`}
        >
          <p className="flex min-w-0 flex-1 basis-60 gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{publishing.changed}</span>
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => void publishing.loadGitHubVersion()}
          >
            Load the GitHub version
          </button>
        </div>
      )}
      {publishing.error && (
        <ErrorMessage error={publishing.error} onDismiss={publishing.dismissError} />
      )}
      {publishing.notice && (
        <p role="status" className={`${alertBox} border-line bg-surface`}>
          {publishing.notice}{" "}
          <button type="button" className="link text-muted" onClick={publishing.dismissNotice}>
            Dismiss
          </button>
        </p>
      )}

      {showStatus && (
        <section aria-labelledby={heading} className={`${card} space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={heading} className="text-lg font-bold tracking-tight">
              {state?.action === "unpublish" ? "Unpublishing" : "Publishing"}
            </h2>
            <button
              ref={checkNow}
              type="button"
              className={ghostButton}
              aria-busy={publishing.checking || undefined}
              onClick={() => void publishing.checkNow()}
            >
              <RefreshCw
                aria-hidden="true"
                className={publishing.checking ? "motion-safe:animate-spin" : undefined}
              />
              Check now
            </button>
          </div>
          <div role="status" className="space-y-2 text-[0.95rem]">
            <p>{state ? stageText(state) : "Checking the pull request…"}</p>
            {state?.mergedOtherVersion && <p>{MERGED_OTHER_VERSION}</p>}
          </div>
          {state && hasTimeline(state.stage) && <PublishTimeline state={state} />}
          {publishing.pollError && (
            <p role="alert" className={`${alertBox} border-red-500/40 bg-red-500/10`}>
              {publishing.pollError}
            </p>
          )}
          {open && (
            <div className="flex flex-wrap gap-2">
              {state.stage === "ci_failed" && state.action === "publish" && (
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={publishing.fixAndRepublish}
                >
                  <Wrench aria-hidden="true" />
                  Fix and republish
                </button>
              )}
              <button type="button" className={secondaryButton} onClick={publishing.requestCancel}>
                <GitPullRequestClosed aria-hidden="true" />
                {state.action === "unpublish" ? "Cancel unpublish" : "Cancel publish"}
              </button>
            </div>
          )}
        </section>
      )}

      {publishing.dialog === "publish" && (
        <PublishDialog
          slug={meta.slug}
          suggestedSlug={publishing.suggestedSlug}
          busy={busy === "publishing"}
          error={publishing.dialogError}
          onConfirm={(slug) => void publishing.confirmPublish(slug)}
          onClose={publishing.closeDialog}
        />
      )}
      {publishing.dialog === "cancel" && (
        <CancelPublishDialog
          pr={state?.pr ?? null}
          action={state?.action ?? null}
          busy={busy === "cancelling"}
          error={publishing.dialogError}
          fallbackFocus={checkNow}
          onConfirm={() => void publishing.confirmCancel()}
          onClose={publishing.closeDialog}
        />
      )}
    </>
  );
}
