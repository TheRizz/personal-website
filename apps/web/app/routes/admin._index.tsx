import { FilePen, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { card, primaryButton } from "~/components/games/ui";
import { createDraft, listDrafts, type DraftSummary } from "~/lib/admin/drafts";
import { adminMeta } from "~/lib/meta";
import type { Route } from "./+types/admin._index";

export const meta: Route.MetaFunction = () => adminMeta("Drafts");

const STATUS: Record<string, string> = {
  draft: "Draft",
  publishing: "Publishing",
  published: "Published",
  failed: "Publish failed",
};

/** The draft list, newest first, and the button that starts a new post. */
export default function Drafts() {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listDrafts()
      .then((list) => !cancelled && setDrafts(list))
      .catch(
        () =>
          !cancelled && setError("Couldn't load your drafts. Check your connection and reload."),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const newPost = async () => {
    setCreating(true);
    try {
      const { id } = await createDraft();
      navigate(`/admin/drafts/${id}`);
    } catch {
      setError("Couldn't start a new post. Try again.");
      setCreating(false);
    }
  };

  return (
    <>
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <PageHeading title="Drafts">
          Posts you're working on. Only you can see this page.
        </PageHeading>
        <button
          type="button"
          className={primaryButton}
          disabled={creating}
          onClick={() => void newPost()}
        >
          <Plus aria-hidden="true" />
          New post
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3"
        >
          {error}
        </p>
      )}
      {drafts === null && !error && <p className="text-muted">Loading…</p>}
      {drafts?.length === 0 && (
        <div className={`${card} flex flex-col items-center px-6 py-12 text-center sm:py-14`}>
          <FilePen aria-hidden="true" className="mb-4 size-8 text-muted" strokeWidth={1.5} />
          <h2 className="text-xl font-bold tracking-tight">No drafts yet</h2>
          <p className="mt-2 max-w-[40ch] text-[0.95rem] leading-relaxed text-muted">
            When you start a post or edit a published one, it shows up here with its status.
          </p>
        </div>
      )}
      {drafts && drafts.length > 0 && (
        <ul className="space-y-3">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <Link
                to={`/admin/drafts/${draft.id}`}
                className={`${card} block transition-colors hover:bg-surface-hover`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="text-lg font-bold tracking-tight">{draft.title || "Untitled"}</h2>
                  <p className="text-sm text-muted">
                    {STATUS[draft.status] ?? draft.status} · edited{" "}
                    {new Date(draft.updatedAt).toLocaleString()}
                  </p>
                </div>
                {draft.summary && <p className="mt-1 text-[0.95rem] text-muted">{draft.summary}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
