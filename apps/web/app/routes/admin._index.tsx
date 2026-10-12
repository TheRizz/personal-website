import { FilePen } from "lucide-react";
import { PageHeading } from "~/components/PageHeading";
import { card } from "~/components/games/ui";
import { adminMeta } from "~/lib/meta";
import type { Route } from "./+types/admin._index";

export const meta: Route.MetaFunction = () => adminMeta("Drafts");

/** The draft list. Empty until the drafts API exists (execution plan Step 10.4). */
export default function Drafts() {
  return (
    <>
      <PageHeading title="Drafts">Posts you're working on. Only you can see this page.</PageHeading>
      <div className={`${card} flex flex-col items-center px-6 py-12 text-center sm:py-14`}>
        <FilePen aria-hidden="true" className="mb-4 size-8 text-muted" strokeWidth={1.5} />
        <h2 className="text-xl font-bold tracking-tight">No drafts yet</h2>
        <p className="mt-2 max-w-[40ch] text-[0.95rem] leading-relaxed text-muted">
          When you start a post or edit a published one, it shows up here with its status.
        </p>
      </div>
    </>
  );
}
