import { FilePen, Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { UnpublishDialog } from "~/components/admin/PublishDialog";
import { card, primaryButton, secondaryButton } from "~/components/games/ui";
import { ApiError, createDraft, listDrafts, type DraftSummary } from "~/lib/admin/drafts";
import {
  POST_PROBLEMS,
  describePublishError,
  listPosts,
  unpublishPost,
  type ErrorText,
  type PostOnMain,
} from "~/lib/admin/publish";
import { formatLongDate } from "~/lib/dates";
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
      <PublishedPosts />
    </>
  );
}

/**
 * The posts on GitHub's `main` (design doc §4.9.7): Edit opens a draft of one, Unpublish opens a
 * pull request that deletes it.
 */
function PublishedPosts() {
  const navigate = useNavigate();
  const heading = useId();
  const [posts, setPosts] = useState<PostOnMain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unpublishing, setUnpublishing] = useState<PostOnMain | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<ErrorText | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPosts()
      .then((list) => !cancelled && setPosts(list.posts))
      .catch(
        (failure: unknown) =>
          !cancelled &&
          setError(`Couldn't load the published posts. ${describePublishError(failure).text}`),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const unpublish = async (post: PostOnMain) => {
    setBusy(true);
    setDialogError(null);
    try {
      const { draftId } = await unpublishPost(post.slug);
      navigate(`/admin/drafts/${draftId}`);
    } catch (failure) {
      const text = describePublishError(failure);
      // The post's draft has a PR open already: link it.
      const draftId =
        failure instanceof ApiError && failure.code === "publishing" ? post.draft?.id : undefined;
      setDialogError(draftId ? { ...text, draftId } : text);
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={heading} className="mt-14">
      <h2 id={heading} className="text-2xl font-bold tracking-tight">
        Published posts
      </h2>
      <p className="mt-2 mb-6 text-[0.95rem] text-muted">
        The posts on GitHub&apos;s main branch. Edit opens a draft of one; Unpublish opens a pull
        request that removes it.
      </p>
      {error && (
        <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          {error}
        </p>
      )}
      {posts === null && !error && <p className="text-muted">Loading the published posts…</p>}
      {posts?.length === 0 && <p className="text-muted">No posts on main yet.</p>}
      {posts && posts.length > 0 && (
        <ul aria-label="Published posts" className="space-y-3">
          {posts.map((post) => (
            <PublishedPost
              key={post.path}
              post={post}
              onUnpublish={() => {
                setDialogError(null);
                setUnpublishing(post);
              }}
            />
          ))}
        </ul>
      )}
      {unpublishing && (
        <UnpublishDialog
          path={unpublishing.path}
          slug={unpublishing.slug}
          busy={busy}
          error={dialogError}
          onConfirm={() => void unpublish(unpublishing)}
          onClose={() => setUnpublishing(null)}
        />
      )}
    </section>
  );
}

function PublishedPost({ post, onUnpublish }: { post: PostOnMain; onUnpublish: () => void }) {
  const title = useId();
  const draft = post.draft;
  return (
    <li className={`${card} flex flex-wrap items-start justify-between gap-x-4 gap-y-3`}>
      <div className="min-w-0 flex-1 basis-64">
        <h3 id={title} className="text-lg font-bold tracking-tight [overflow-wrap:anywhere]">
          {/* A full page load: the public post isn't part of the admin app. */}
          <a href={`/blog/${post.slug}`} className="hover:underline">
            {post.title ?? post.slug}
          </a>
        </h3>
        <p className="mt-1 text-sm text-muted">
          {post.date ? <time dateTime={post.date}>{formatLongDate(post.date)}</time> : "No date"}
          {draft?.status === "publishing" && draft.prNumber !== null && (
            <>
              {" · "}
              <Link to={`/admin/drafts/${draft.id}`} className="link">
                {draft.prAction === "unpublish" ? "Unpublishing" : "Publishing"}, PR #
                {draft.prNumber}
              </Link>
            </>
          )}
        </p>
        {post.problem && <p className="mt-1 text-sm text-muted">{POST_PROBLEMS[post.problem]}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {post.editable && (
          <Link
            to={`/admin/posts/${post.slug}`}
            className={secondaryButton}
            aria-describedby={title}
          >
            Edit
          </Link>
        )}
        {post.problem !== "bad_path" && (
          <button
            type="button"
            className={secondaryButton}
            aria-describedby={title}
            onClick={onUnpublish}
          >
            Unpublish
          </button>
        )}
      </div>
    </li>
  );
}
