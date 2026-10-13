import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ErrorMessage } from "~/components/admin/PublishDialog";
import { ApiError } from "~/lib/admin/drafts";
import {
  POST_PROBLEMS,
  describePublishError,
  importPost,
  type ErrorText,
} from "~/lib/admin/publish";
import { adminMeta } from "~/lib/meta";
import { isSlug } from "~/lib/publish/post-path";
import type { PostProblem } from "~/lib/publish/state";
import type { Route } from "./+types/admin.posts.$slug";

// Opens the edit draft for a post on `main` (design doc §4.9.2), the target of the public Edit
// link: imports the post into a draft, or finds the one it has, then goes to the editor. Safe on
// page load because the import is idempotent and never writes to GitHub. Browser only, like every
// admin page; nothing is taken from the query string.

export const meta: Route.MetaFunction = () => adminMeta("Open post");

const NOT_FOUND: ErrorText = { text: "No published post with that address." };

/** What to say when the post can't be opened in the editor. */
function importFailure(error: unknown): ErrorText {
  if (error instanceof ApiError) {
    if (error.status === 404) return NOT_FOUND;
    const problem = error.details?.problem;
    if (
      error.code === "unsupported_post" &&
      typeof problem === "string" &&
      Object.hasOwn(POST_PROBLEMS, problem)
    ) {
      return { text: POST_PROBLEMS[problem as PostProblem] };
    }
  }
  return describePublishError(error);
}

export default function OpenPost() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const valid = isSlug(slug);
  // Keyed by slug, so a failure for one post never shows on another.
  const [failure, setFailure] = useState<{ slug: string; error: ErrorText } | null>(null);

  useEffect(() => {
    // An address that can't be a post isn't sent anywhere.
    if (!valid) return;
    let cancelled = false;
    importPost(slug)
      .then(({ id }) => {
        if (!cancelled) navigate(`/admin/drafts/${id}`, { replace: true });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure({ slug, error: importFailure(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, valid, navigate]);

  const error = !valid ? NOT_FOUND : failure?.slug === slug ? failure.error : null;
  return (
    <>
      <p className="mb-4">
        <Link to="/admin" className="link text-sm text-muted">
          ← All drafts
        </Link>
      </p>
      {error ? <ErrorMessage error={error} /> : <p className="text-muted">Opening the post…</p>}
    </>
  );
}
