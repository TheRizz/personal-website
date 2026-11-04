import { Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { card, inputClass, primaryButton, secondaryButton } from "~/components/games/ui";
import { ApiError } from "~/lib/admin/drafts";
import {
  createProject,
  deleteProject,
  listAdminProjects,
  updateProject,
} from "~/lib/admin/projects";
import { adminMeta } from "~/lib/meta";
import {
  MAX_NOTE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  cleanLine,
  groupProjects,
  type Priority,
  type Project,
  type ProjectFields,
} from "~/lib/projects";
import type { Route } from "./+types/admin.projects";

// The home page's current projects: add one, change where it shows and how far along it is, or
// delete it. A save is public at once. Built for a phone: one form per project, a plain select for
// where it shows, no dragging. Like every admin page, it has no loader; the data comes from
// /api/admin.

export const meta: Route.MetaFunction = () => adminMeta("Projects");

/** Where a project shows: the select's value, mapped to status and priority. */
type Place = "1" | "2" | "3" | "active" | "backlog";
const PLACES: { value: Place; label: string }[] = [
  { value: "1", label: "Priority 1" },
  { value: "2", label: "Priority 2" },
  { value: "3", label: "Priority 3" },
  { value: "active", label: "In progress, no priority" },
  { value: "backlog", label: "Backlog (folded away)" },
];

const placeOf = (project: Pick<Project, "status" | "priority">): Place =>
  project.status === "backlog" ? "backlog" : project.priority ? `${project.priority}` : "active";

function fromPlace(place: Place): Pick<ProjectFields, "status" | "priority"> {
  if (place === "backlog") return { status: "backlog", priority: null };
  if (place === "active") return { status: "active", priority: null };
  return { status: "active", priority: Number(place) as Priority };
}

/** The form's state: every field as typed. */
interface Draft {
  title: string;
  summary: string;
  url: string;
  place: Place;
  progress: string;
  note: string;
}

const EMPTY: Draft = { title: "", summary: "", url: "", place: "active", progress: "", note: "" };

const toDraft = (project: Project): Draft => ({
  title: project.title,
  summary: project.summary,
  url: project.url,
  place: placeOf(project),
  progress: project.progress === null ? "" : String(project.progress),
  note: project.note,
});

/** The fields to send, or a message saying what to fix. */
function toFields(draft: Draft): ProjectFields | string {
  const title = cleanLine(draft.title);
  if (!title) return "Give the project a title.";
  const progressText = draft.progress.trim();
  let progress: number | null = null;
  if (progressText !== "") {
    progress = Number(progressText.replace(/%$/, ""));
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
      return "Progress must be a whole number from 0 to 100, or empty.";
    }
  }
  return {
    title,
    summary: cleanLine(draft.summary),
    url: draft.url.trim(),
    note: cleanLine(draft.note),
    progress,
    ...fromPlace(draft.place),
  };
}

const sameDraft = (a: Draft, b: Draft) =>
  (Object.keys(a) as (keyof Draft)[]).every((key) => a[key].trim() === b[key].trim());

/** What to tell the owner about a failure: the server's message, never a stack. */
const failure = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

export default function AdminProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = () =>
    listAdminProjects()
      .then(setProjects)
      .catch(() => setError("Couldn't load your projects. Check your connection and reload."));

  useEffect(() => {
    void reload();
  }, []);

  // Saving a priority can take it from another project, so the list is read again after a save.
  const saved = () => reload();
  const groups = projects ? groupProjects(projects) : null;
  const ordered = groups ? [...groups.featured, ...groups.others, ...groups.backlog] : [];

  return (
    <>
      <p className="mb-6 text-sm">
        <Link to="/admin" className="link">
          ← Drafts
        </Link>
      </p>
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <PageHeading title="Projects">
          {/* A full page load: the home page isn't part of the admin app. */}
          What shows at the top of{" "}
          <a href="/" className="link">
            your home page
          </a>
          . A change you save is public straight away.
        </PageHeading>
        <button
          type="button"
          className={primaryButton}
          disabled={adding}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden="true" />
          Add project
        </button>
      </div>
      {adding && (
        <ProjectForm
          heading="New project"
          initial={EMPTY}
          onSave={async (fields) => {
            await createProject(fields);
            setAdding(false);
            await saved();
          }}
          onCancel={() => setAdding(false)}
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
      {projects === null && !error && <p className="text-muted">Loading…</p>}
      {projects?.length === 0 && !adding && (
        <p className="text-muted">
          No projects yet. Tap Add project to put your first one on the home page.
        </p>
      )}
      {ordered.length > 0 && (
        <ul aria-label="Your projects" className="space-y-3">
          {ordered.map((project) => (
            <li key={project.id}>
              <details className="group rounded-xl bg-surface">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-3 hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
                  <span>
                    <span className="block font-semibold">{project.title}</span>
                    <span className="block text-sm text-muted">
                      {PLACES.find((place) => place.value === placeOf(project))?.label}
                      {project.progress !== null && `, ${project.progress}%`}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted transition-transform duration-200 group-open:rotate-180"
                  />
                </summary>
                <ProjectForm
                  heading={project.title}
                  initial={toDraft(project)}
                  onSave={async (fields) => {
                    await updateProject(project.id, fields);
                    await saved();
                  }}
                  onDelete={async () => {
                    await deleteProject(project.id);
                    await saved();
                  }}
                />
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One project's form, for a new project or a saved one. */
function ProjectForm({
  heading,
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  heading: string;
  initial: Draft;
  onSave: (fields: ProjectFields) => Promise<void>;
  onCancel?: () => void;
  onDelete?: () => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const isNew = !onDelete;
  // A save reads the list again, and can move a priority off another project: take what's stored.
  const stored = JSON.stringify(initial);
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setDraft(initial);
  }
  const changed = !sameDraft(draft, initial);
  const set = (key: keyof Draft) => (value: string) => {
    setDraft((was) => ({ ...was, [key]: value }));
    setSavedOnce(false);
  };

  const save = async () => {
    const fields = toFields(draft);
    if (typeof fields === "string") {
      setError(fields);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(fields);
      setSavedOnce(true);
    } catch (failed) {
      setError(failure(failed, "Couldn't save. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    if (!window.confirm(`Delete "${initial.title}"? It comes off your home page.`)) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (failed) {
      setError(failure(failed, "Couldn't delete. Check your connection and try again."));
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={isNew ? `${card} mb-8` : "px-5 pt-2 pb-5"}
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-heading`} className={isNew ? "text-xl font-bold" : "sr-only"}>
          {heading}
        </h2>
        <Field id={`${id}-title`} label="Title">
          <input
            id={`${id}-title`}
            value={draft.title}
            maxLength={MAX_TITLE_LENGTH}
            required
            onChange={(event) => set("title")(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field id={`${id}-place`} label="Where it shows">
          <select
            id={`${id}-place`}
            value={draft.place}
            onChange={(event) => set("place")(event.target.value)}
            className={inputClass}
          >
            {PLACES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
          <Field id={`${id}-progress`} label="Progress %" hint="0 to 100, or empty.">
            <input
              id={`${id}-progress`}
              value={draft.progress}
              inputMode="numeric"
              pattern="[0-9]{1,3}%?"
              placeholder="e.g. 40"
              onChange={(event) => set("progress")(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            id={`${id}-note`}
            label="Status (optional)"
            hint="A few words, like Waiting on playtest."
          >
            <input
              id={`${id}-note`}
              value={draft.note}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(event) => set("note")(event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <Field id={`${id}-summary`} label="Description (optional)">
          <textarea
            id={`${id}-summary`}
            value={draft.summary}
            maxLength={MAX_SUMMARY_LENGTH}
            rows={2}
            onChange={(event) => set("summary")(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          id={`${id}-url`}
          label="Link (optional)"
          hint="A full web address, or a page here like /games/volley."
        >
          <input
            id={`${id}-url`}
            value={draft.url}
            maxLength={MAX_URL_LENGTH}
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => set("url")(event.target.value)}
            className={inputClass}
          />
        </Field>
        {error && (
          <p role="alert" className="text-[0.95rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {savedOnce && !changed && (
            <p role="status" className="mr-auto flex items-center gap-1 text-sm text-muted">
              <Check aria-hidden="true" className="size-4" />
              Saved
            </p>
          )}
          {onCancel && (
            <button type="button" className={secondaryButton} onClick={onCancel}>
              Cancel
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() => void remove()}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </button>
          )}
          <button type="submit" className={primaryButton} disabled={busy || (!isNew && !changed)}>
            {isNew ? "Add to home page" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}
