import { MarkdownError, markdownToDoc, type DocNode } from "@site/content-markdown";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Download,
  History,
  LoaderCircle,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { card, ghostButton, inputClass, secondaryButton } from "~/components/games/ui";
import { Autosaver, type AutosaveState } from "~/lib/admin/autosave";
import {
  discardDraft,
  getDraft,
  listRevisions,
  restoreRevision,
  saveDraft,
  type Draft,
  type DraftFields,
  type Revision,
} from "~/lib/admin/drafts";
import { figureSrcs, markImagesPublished } from "~/lib/admin/images";
import { localDate, normalizeTags, postFile } from "~/lib/admin/post-file";
import { Preview } from "./Preview";
import { RichEditor } from "./RichEditor";

// The draft editor (design doc §4.9.3, execution plan Step 10.5). Loaded with React.lazy from
// /admin/drafts/:id only, so no public page ships TipTap or the Markdown bridge.

const SUMMARY_MAX = 300;
const copyKey = (id: string) => `draft-copy:${id}`;

interface LocalCopy {
  rev: number;
  fields: DraftFields;
  savedAt: number;
}

/** The crash copy kept in this browser (design doc §4.9.5); storage may be unavailable. */
const localCopy = {
  read(id: string): LocalCopy | null {
    try {
      const raw = window.localStorage.getItem(copyKey(id));
      return raw ? (JSON.parse(raw) as LocalCopy) : null;
    } catch {
      return null;
    }
  },
  write(id: string, copy: LocalCopy) {
    try {
      window.localStorage.setItem(copyKey(id), JSON.stringify(copy));
    } catch {
      // Full or blocked: the server copy still autosaves.
    }
  },
  clear(id: string) {
    try {
      window.localStorage.removeItem(copyKey(id));
    } catch {
      // Nothing to clear.
    }
  },
};

const sameFields = (a: DraftFields, b: DraftFields) =>
  a.title === b.title &&
  a.summary === b.summary &&
  (a.category ?? null) === (b.category ?? null) &&
  a.bodyMd === b.bodyMd &&
  a.tags.join(",") === b.tags.join(",");

/** The editor JSON for `markdown`, or the reason the rich editor can't show it. */
function toDoc(markdown: string): { doc: DocNode } | { error: string } {
  try {
    return { doc: markdownToDoc(markdown) };
  } catch (error) {
    return { error: error instanceof MarkdownError ? error.message : String(error) };
  }
}

const isDesktop = () => window.matchMedia("(min-width: 64rem)").matches;
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(min-width: 64rem)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    isDesktop,
    () => true,
  );
}

export default function DraftEditor({ draft: loaded }: { draft: Draft }) {
  const navigate = useNavigate();
  const id = loaded.id;
  const [title, setTitle] = useState(loaded.title);
  const [summary, setSummary] = useState(loaded.summary);
  const [category, setCategory] = useState(loaded.category ?? "");
  const [tagsText, setTagsText] = useState(loaded.tags.join(", "));
  const [bodyMd, setBodyMd] = useState(loaded.bodyMd);
  const initialDoc = useMemo(() => toDoc(loaded.bodyMd), [loaded.bodyMd]);
  const [mode, setMode] = useState<"rich" | "raw">("doc" in initialDoc ? "rich" : "raw");
  const [richDoc, setRichDoc] = useState<DocNode | null>(
    "doc" in initialDoc ? initialDoc.doc : null,
  );
  const [modeError, setModeError] = useState<string | null>(
    "error" in initialDoc ? initialDoc.error : null,
  );
  // Remounts the rich editor when its content is replaced from outside (raw tab, reload, restore).
  const [editorKey, setEditorKey] = useState(0);
  const [phoneTab, setPhoneTab] = useState<"write" | "preview">("write");
  const desktop = useIsDesktop();
  const [notice, setNotice] = useState<string | null>(null);
  // A crash copy that the server never got, from this browser (only at the rev it started from).
  const [recovered, setRecovered] = useState<LocalCopy | null>(() => {
    const copy = localCopy.read(loaded.id);
    return copy && copy.rev === loaded.rev && !sameFields(copy.fields, loaded) ? copy : null;
  });
  const [revisions, setRevisions] = useState<Revision[] | null>(null);

  const fields = useMemo<DraftFields>(
    () => ({
      title,
      summary,
      category: category.trim() || null,
      tags: normalizeTags(tagsText.split(",")),
      bodyMd,
    }),
    [title, summary, category, tagsText, bodyMd],
  );

  const [save, setSave] = useState<AutosaveState>({
    status: "saved",
    rev: loaded.rev,
    errors: 0,
    lastSavedAt: null,
    conflict: null,
  });
  const [saver] = useState(
    () =>
      new Autosaver({
        rev: loaded.rev,
        save: (baseRev, next, revision) => saveDraft(id, baseRev, next, revision),
        onChange: setSave,
      }),
  );
  useEffect(() => {
    saver.revive();
    return () => saver.dispose();
  }, [saver]);
  // What the server has; an edit is anything that differs from it.
  const baseline = useRef<DraftFields>({
    title: loaded.title,
    summary: loaded.summary,
    category: loaded.category,
    tags: loaded.tags,
    bodyMd: loaded.bodyMd,
  });

  /** Replaces everything on screen with `draft`, e.g. after Reload or Restore. */
  const applyDraft = useCallback(
    (next: Draft) => {
      setTitle(next.title);
      setSummary(next.summary);
      setCategory(next.category ?? "");
      setTagsText(next.tags.join(", "));
      setBodyMd(next.bodyMd);
      const parsed = toDoc(next.bodyMd);
      if ("doc" in parsed) {
        setRichDoc(parsed.doc);
        setModeError(null);
      } else {
        setMode("raw");
        setModeError(parsed.error);
      }
      setEditorKey((key) => key + 1);
      const serverFields: DraftFields = {
        title: next.title,
        summary: next.summary,
        category: next.category,
        tags: next.tags,
        bodyMd: next.bodyMd,
      };
      baseline.current = serverFields;
      saver.reset(next.rev, serverFields);
      localCopy.clear(next.id);
    },
    [saver],
  );

  const reload = useCallback(async () => {
    try {
      applyDraft(await getDraft(id));
      setNotice(null);
    } catch {
      setNotice("Couldn't load the latest version. Check your connection and try again.");
    }
  }, [applyDraft, id]);

  // Every edit goes to autosave and to the crash copy.
  useEffect(() => {
    if (sameFields(fields, baseline.current)) return;
    baseline.current = fields;
    saver.change(fields);
    localCopy.write(id, { rev: saver.current.rev, fields, savedAt: Date.now() });
  }, [fields, id, saver]);

  // Other tabs on this draft: tell them about each save, and take theirs when this tab has
  // nothing unsaved.
  useEffect(() => {
    const bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`draft:${id}`);
    saver.setOnSaved((rev) => {
      bc?.postMessage({ rev });
      if (!saver.hasUnsavedChanges) localCopy.clear(id);
    });
    if (bc) {
      bc.onmessage = (event: MessageEvent<{ rev?: number }>) => {
        const rev = event.data?.rev;
        if (typeof rev === "number" && rev > saver.current.rev && !saver.hasUnsavedChanges) {
          void reload();
        }
      };
    }
    return () => {
      saver.setOnSaved(undefined);
      bc?.close();
    };
  }, [id, reload, saver]);

  // Warn before leaving with changes the server doesn't have.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saver.hasUnsavedChanges) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saver]);

  // Ctrl/Cmd+S saves now and keeps a revision.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saver.flush("manual");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saver]);

  const switchMode = (next: "rich" | "raw") => {
    if (next === mode) return;
    if (next === "raw") {
      setMode("raw");
      return;
    }
    const parsed = toDoc(bodyMd);
    if ("error" in parsed) {
      setModeError(parsed.error);
      return;
    }
    setModeError(null);
    setRichDoc(parsed.doc);
    setEditorKey((key) => key + 1);
    setMode("rich");
  };

  const file = postFile({ ...fields, slug: loaded.slug, cover: loaded.cover }, localDate());

  // The file may be committed by hand from here, so its images must outlive this draft: discarding
  // it and the daily clean-up skip published images (design doc §4.9.6).
  const keepImages = () => {
    const srcs = figureSrcs(fields.bodyMd);
    if (srcs.length === 0) return;
    markImagesPublished(srcs).catch(() =>
      setNotice(
        "Couldn't mark this post's images as published, so discarding the draft would delete " +
          "them. Download or copy it again to retry.",
      ),
    );
  };

  const download = () => {
    if (!file.ok) return setNotice(file.errors.join(" "));
    const url = URL.createObjectURL(new Blob([file.content], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(`Downloaded ${file.filename}. Commit it as ${file.path} to publish.`);
    keepImages();
  };

  const copy = async () => {
    if (!file.ok) return setNotice(file.errors.join(" "));
    try {
      await navigator.clipboard.writeText(file.content);
      setNotice(`Copied. Save it as ${file.path} to publish.`);
    } catch {
      setNotice("Couldn't copy. Use Download .md instead.");
      return;
    }
    keepImages();
  };

  const discard = async () => {
    if (!window.confirm("Discard this draft and its revisions? This can't be undone.")) return;
    try {
      saver.dispose();
      await discardDraft(id);
      localCopy.clear(id);
      navigate("/admin");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't discard the draft.");
    }
  };

  const openRevisions = async () => {
    try {
      setRevisions(await listRevisions(id));
    } catch {
      setNotice("Couldn't load the revisions.");
    }
  };

  const restore = async (rev: number) => {
    await saver.flush();
    try {
      await restoreRevision(id, rev, saver.current.rev);
      await reload();
      setRevisions(null);
      setNotice(`Restored the version from revision ${rev}. The version before it is in the list.`);
    } catch {
      setNotice("Couldn't restore that revision. Reload and try again.");
    }
  };

  const showPreview = desktop || phoneTab === "preview";
  const showWrite = desktop || phoneTab === "write";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <SaveStatus state={save} />
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button type="button" className={ghostButton} onClick={() => void saver.flush("manual")}>
            <Save aria-hidden="true" />
            Save
          </button>
          <button type="button" className={ghostButton} onClick={() => void openRevisions()}>
            <History aria-hidden="true" />
            Revisions
          </button>
          <button type="button" className={ghostButton} onClick={download}>
            <Download aria-hidden="true" />
            Download .md
          </button>
          <button type="button" className={ghostButton} onClick={() => void copy()}>
            <ClipboardCopy aria-hidden="true" />
            Copy as Markdown
          </button>
          <button type="button" className={ghostButton} onClick={() => void discard()}>
            <Trash2 aria-hidden="true" />
            Discard
          </button>
        </div>
      </div>

      {save.status === "conflict" && (
        <Banner>
          This draft was saved in another tab or on another device.{" "}
          <button type="button" className="link font-semibold" onClick={() => void reload()}>
            Load that version
          </button>{" "}
          or{" "}
          <button
            type="button"
            className="link font-semibold"
            onClick={() => void saver.overwrite()}
          >
            keep this one
          </button>
          . Keeping this one saves the other version as a revision.
        </Banner>
      )}
      {save.status === "stopped" && (
        <Banner>
          Autosave stopped after {save.errors} failed saves. Your changes are kept in this browser.{" "}
          <button type="button" className="link font-semibold" onClick={() => void saver.retry()}>
            Try again
          </button>
          .
        </Banner>
      )}
      {recovered && (
        <Banner>
          This browser has changes to this draft that never reached the server.{" "}
          <button
            type="button"
            className="link font-semibold"
            onClick={() => {
              const { fields: f } = recovered;
              setTitle(f.title);
              setSummary(f.summary);
              setCategory(f.category ?? "");
              setTagsText(f.tags.join(", "));
              setBodyMd(f.bodyMd);
              const parsed = toDoc(f.bodyMd);
              if ("doc" in parsed) setRichDoc(parsed.doc);
              else setMode("raw");
              setEditorKey((key) => key + 1);
              setRecovered(null);
            }}
          >
            Restore them
          </button>{" "}
          or{" "}
          <button
            type="button"
            className="link font-semibold"
            onClick={() => {
              localCopy.clear(id);
              setRecovered(null);
            }}
          >
            discard them
          </button>
          .
        </Banner>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-xl border border-line bg-surface px-4 py-3 text-[0.95rem]"
        >
          {notice}{" "}
          <button type="button" className="link text-muted" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      <MetadataPanel
        title={title}
        summary={summary}
        category={category}
        tagsText={tagsText}
        tags={fields.tags}
        onTitle={setTitle}
        onSummary={setSummary}
        onCategory={setCategory}
        onTags={setTagsText}
      />

      {!desktop && (
        <div role="tablist" aria-label="Editor view" className="flex gap-1">
          {(["write", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={phoneTab === tab}
              onClick={() => setPhoneTab(tab)}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-muted aria-selected:bg-fg aria-selected:text-bg"
            >
              {tab === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {showWrite && (
          <section aria-label="Body" className="min-w-0 space-y-3">
            <div role="tablist" aria-label="Body editor" className="flex gap-1">
              {(["rich", "raw"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={mode === tab}
                  onClick={() => switchMode(tab)}
                  className="rounded-lg px-3 py-1.5 text-sm font-semibold text-muted aria-selected:bg-surface aria-selected:text-fg"
                >
                  {tab === "rich" ? "Editor" : "Raw Markdown"}
                </button>
              ))}
            </div>
            {modeError && (
              <p
                role="alert"
                className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[0.95rem]"
              >
                The editor can't show this Markdown yet, so it stays in Raw Markdown. {modeError}
              </p>
            )}
            {mode === "rich" && richDoc ? (
              <RichEditor
                key={editorKey}
                initialDoc={richDoc}
                onChange={setBodyMd}
                label="Post body"
                draftId={id}
              />
            ) : (
              <textarea
                aria-label="Post body (Markdown)"
                value={bodyMd}
                onChange={(event) => setBodyMd(event.target.value)}
                spellCheck
                className={`${inputClass} min-h-[24rem] font-mono text-[0.9rem] leading-relaxed`}
              />
            )}
          </section>
        )}
        {showPreview && (
          <section className={`${card} min-w-0`}>
            <Preview title={title} markdown={bodyMd} />
          </section>
        )}
      </div>

      {revisions && (
        <RevisionsDialog
          revisions={revisions}
          onRestore={(rev) => void restore(rev)}
          onClose={() => setRevisions(null)}
        />
      )}
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-[0.95rem]"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function SaveStatus({ state }: { state: AutosaveState }) {
  const text = {
    saved: state.lastSavedAt ? "Saved" : "All changes saved",
    dirty: "Unsaved changes",
    saving: "Saving…",
    error: "Couldn't save, retrying",
    stopped: "Autosave stopped",
    conflict: "Saved elsewhere",
  }[state.status];
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-muted">
      {state.status === "saving" ? (
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      ) : state.status === "saved" ? (
        <Check aria-hidden="true" className="size-4" />
      ) : null}
      {text}
    </p>
  );
}

function MetadataPanel(props: {
  title: string;
  summary: string;
  category: string;
  tagsText: string;
  tags: string[];
  onTitle: (value: string) => void;
  onSummary: (value: string) => void;
  onCategory: (value: string) => void;
  onTags: (value: string) => void;
}) {
  const label = "mb-1.5 block text-sm font-semibold";
  const hint = "mt-1.5 text-sm text-muted";
  return (
    <section aria-label="Post details" className={`${card} grid gap-5 sm:grid-cols-2`}>
      <div className="sm:col-span-2">
        <label htmlFor="draft-title" className={label}>
          Title
        </label>
        <input
          id="draft-title"
          value={props.title}
          onChange={(event) => props.onTitle(event.target.value)}
          placeholder="Untitled"
          aria-invalid={!props.title.trim() || undefined}
          className={`${inputClass} text-xl font-bold`}
        />
        {!props.title.trim() && <p className={hint}>Needed before the post can be published.</p>}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="draft-summary" className={label}>
          Summary
        </label>
        <textarea
          id="draft-summary"
          value={props.summary}
          maxLength={SUMMARY_MAX}
          rows={2}
          onChange={(event) => props.onSummary(event.target.value)}
          aria-describedby="draft-summary-count"
          className={inputClass}
        />
        <p id="draft-summary-count" className={hint}>
          {props.summary.length}/{SUMMARY_MAX}
          {!props.summary.trim() && " · Needed before the post can be published."}
        </p>
      </div>
      <div>
        <label htmlFor="draft-category" className={label}>
          Category <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="draft-category"
          value={props.category}
          onChange={(event) => props.onCategory(event.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="draft-tags" className={label}>
          Tags <span className="font-normal text-muted">(comma separated)</span>
        </label>
        <input
          id="draft-tags"
          value={props.tagsText}
          onChange={(event) => props.onTags(event.target.value)}
          aria-describedby="draft-tags-saved"
          className={inputClass}
        />
        <p id="draft-tags-saved" className={hint}>
          {props.tags.length > 0 ? `Saved as: ${props.tags.join(", ")}` : "No tags"}
        </p>
      </div>
    </section>
  );
}

function RevisionsDialog({
  revisions,
  onRestore,
  onClose,
}: {
  revisions: Revision[];
  onRestore: (rev: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const reasons: Record<Revision["reason"], string> = {
    interval: "Autosave",
    manual: "Saved",
    publish: "Published",
    restore: "Restored",
    conflict: "Replaced by another tab",
  };
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="revisions-title"
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl border border-line bg-bg p-6 text-fg backdrop:bg-black/50"
    >
      <h2 id="revisions-title" className="mb-4 text-xl font-bold">
        Revisions
      </h2>
      {revisions.length === 0 ? (
        <p className="text-muted">
          No revisions yet. One is kept every 10 minutes while you write, and each time you press
          Save.
        </p>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
          {revisions.map((revision) => (
            <li key={revision.rev} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">{revision.title || "Untitled"}</p>
                <p className="text-sm text-muted">
                  {reasons[revision.reason]} · {new Date(revision.createdAt).toLocaleString()}
                </p>
              </div>
              <button type="button" className={ghostButton} onClick={() => onRestore(revision.rev)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <form method="dialog" className="mt-5 text-right">
        <button type="submit" className={secondaryButton}>
          Close
        </button>
      </form>
    </dialog>
  );
}
