import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, getDraft, type Draft } from "~/lib/admin/drafts";
import { adminMeta } from "~/lib/meta";
import type { Route } from "./+types/admin.drafts.$id";

// One draft in the editor (design doc §4.9.2). The data comes from /api/admin in the browser, and
// the editor itself is a lazy chunk, so TipTap and the Markdown bridge load on this page only.

const DraftEditor = lazy(() => import("~/components/admin/DraftEditor.client"));

export const meta: Route.MetaFunction = () => adminMeta("Edit draft");

type Load =
  { state: "loading" } | { state: "ready"; draft: Draft } | { state: "error"; message: string };

export default function DraftPage() {
  const { id = "" } = useParams();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    getDraft(id)
      .then((draft) => !cancelled && setLoad({ state: "ready", draft }))
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof ApiError && error.status === 404
            ? "This draft doesn't exist. It may have been discarded."
            : "Couldn't load the draft. Check your connection and reload.";
        setLoad({ state: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loading = <p className="text-muted">Loading the draft…</p>;
  return (
    <>
      <p className="mb-4">
        <Link to="/admin" className="link text-sm text-muted">
          ← All drafts
        </Link>
      </p>
      {load.state === "loading" && loading}
      {load.state === "error" && <p role="alert">{load.message}</p>}
      {load.state === "ready" && (
        <Suspense fallback={loading}>
          <DraftEditor key={load.draft.id} draft={load.draft} />
        </Suspense>
      )}
    </>
  );
}
