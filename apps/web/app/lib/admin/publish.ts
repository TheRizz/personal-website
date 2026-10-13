import { dateFromPath } from "../publish/post-path";
import type { PostOnMain, PostProblem, PublishState, Stage } from "../publish/state";
import { ApiError, call, json, type Draft } from "./drafts";
import { localDate } from "./post-file";

// Typed calls to the publishing API (worker/publish.ts, design doc §4.9.2 and §4.9.7), and the
// words the editor and /admin show for its answers. Every request goes through `call`, so the owner
// gate sees the headers it needs, and every POST sends a JSON string body, even an empty one.

export type { PostOnMain, PublishState, Stage } from "../publish/state";
export { isTerminal } from "../publish/state";

const draftPath = (id: string, action: string) =>
  `/api/admin/drafts/${encodeURIComponent(id)}/${action}`;
const postPath = (slug: string, action: string) =>
  `/api/admin/posts/${encodeURIComponent(slug)}/${action}`;

/** Opens the draft's pull request, or pushes to the one it has open. */
export function publishDraft(
  id: string,
  body: { baseRev: number; date: string; slug?: string },
): Promise<PublishState & { republished: boolean; warnings?: string[] }> {
  return call(draftPath(id, "publish"), json("POST", body));
}

/** Where the draft's pull request is, from opened to live. */
export function getPublishState(id: string): Promise<PublishState> {
  return call(draftPath(id, "status"));
}

/** Closes the draft's open pull request and deletes its branch. */
export function cancelPublish(id: string): Promise<PublishState> {
  return call(draftPath(id, "cancel"), json("POST", {}));
}

/** The post files on `main`, with the draft that tracks each one. */
export function listPosts(): Promise<{ treeSha: string; posts: PostOnMain[] }> {
  return call("/api/admin/posts");
}

/**
 * The edit draft for the post `slug`, created from `main` if it has none. With `refresh`, loads
 * the version on `main` into that draft instead ("Load the GitHub version").
 */
export function importPost(
  slug: string,
  refresh?: { baseRev: number },
): Promise<{ id: string; created: boolean; rev?: number; converted?: boolean }> {
  const body = refresh ? { refresh: true, baseRev: refresh.baseRev } : {};
  return call(postPath(slug, "import"), json("POST", body));
}

/** Opens a pull request that deletes the post `slug` from `main`. */
export function unpublishPost(slug: string): Promise<PublishState & { draftId: string }> {
  return call(postPath(slug, "unpublish"), json("POST", {}));
}

/** The draft fields publishing reads. The editor keeps them in step with the server. */
export type DraftMeta = Pick<
  Draft,
  "kind" | "slug" | "status" | "sourcePath" | "postDate" | "prAction"
>;

/** `draft`'s publishing fields, without its content. */
export function metaOf(draft: DraftMeta): DraftMeta {
  const { kind, slug, status, sourcePath, postDate, prAction } = draft;
  return { kind, slug, status, sourcePath, postDate, prAction };
}

/** Stages with an open, unmerged pull request, which Republish and Cancel act on. */
const OPEN_STAGES: ReadonlySet<Stage> = new Set(["opened", "ci_running", "ci_failed", "review"]);
/** Stages after GitHub merged the pull request. */
const MERGED_STAGES: ReadonlySet<Stage> = new Set(["merged", "deploying", "deploy_failed", "live"]);

/** Whether `stage` has a pull request that is still open. */
export function isOpenStage(stage: Stage): boolean {
  return OPEN_STAGES.has(stage);
}

/**
 * The editor's publish button (contract §10.2): `Republish` while a publish PR is open,
 * `Publish changes` for a post on `main` (also once a publish PR is merged, before it is live),
 * else `Publish`. `blockedBy` says why it is disabled: an unpublish PR is open. Until the status
 * arrives it goes by the draft's own fields.
 */
export function publishButton(
  meta: DraftMeta,
  state: PublishState | null,
): { label: "Publish" | "Publish changes" | "Republish"; blockedBy: string | null } {
  const open = state ? OPEN_STAGES.has(state.stage) : meta.status === "publishing";
  const action = state ? state.action : meta.prAction;
  const onMain =
    state && MERGED_STAGES.has(state.stage) ? action === "publish" : meta.kind === "edit";
  return {
    label: open && action === "publish" ? "Republish" : onMain ? "Publish changes" : "Publish",
    blockedBy: open && action === "unpublish" ? "An unpublish PR is open." : null,
  };
}

/**
 * One sentence on where the pull request is, for the status line. It avoids the timeline's step
 * labels, so each label is the only text that reads that way.
 */
export function stageText(state: PublishState): string {
  const unpublish = state.action === "unpublish";
  switch (state.stage) {
    case "draft":
      return "No open pull request.";
    case "closed":
      return "The PR was closed without merging. This draft is a draft again.";
    case "opened":
      return "The pull request is open on GitHub. CI starts in a moment.";
    case "ci_running":
      return "CI is checking the pull request. This takes about 2 minutes.";
    case "ci_failed":
      return unpublish
        ? "CI found a problem. Open the run to see it, or cancel the PR."
        : "CI found a problem. Open the run to see it, then fix it and republish, or cancel the PR.";
    case "review":
      return "CI passed. Review the pull request on GitHub, then Squash and merge it.";
    case "merged":
      return "The pull request is in main. The deploy starts in a moment.";
    case "deploying":
      return "The site is being deployed. This takes about a minute.";
    case "deploy_failed":
      return (
        "The deploy failed. Re-run it from the run page if it is the newest deploy; if a later " +
        "deploy has run, press Check now."
      );
    case "live":
      return unpublish
        ? "The post is off the site. It stays in git history."
        : "The post is on the site.";
  }
}

/** Shown when GitHub merged something other than the last version the editor pushed. */
export const MERGED_OTHER_VERSION =
  "GitHub merged a different version than your last publish. Publish changes to send your " +
  "latest text.";

const pathDate = (path: string | null): string | null => {
  try {
    return path ? dateFromPath(path) : null;
  } catch {
    return null;
  }
};

/**
 * The dates a draft's file gets (design doc §4.9.7): a post on `main` keeps its `date` and gets
 * `updated` = today; a new post is dated by its file name once it has one, else today.
 */
export function fileDates(
  draft: Pick<Draft, "kind" | "sourcePath" | "postDate">,
  today = localDate(),
): { date: string; updated?: string } {
  if (draft.kind === "edit") {
    return { date: draft.postDate ?? pathDate(draft.sourcePath) ?? today, updated: today };
  }
  return { date: pathDate(draft.sourcePath) ?? today };
}

/** Shown when a republish pushed the commit but couldn't refresh the PR's description. */
export const PR_NOT_UPDATED = "Your changes are pushed, but the PR description wasn't refreshed.";

/** Why the editor can't take a post on `main`, as `/admin` lists it. */
export const POST_PROBLEMS: Record<PostProblem, string> = {
  draft: "Marked draft on GitHub, so the editor can't edit it.",
  custom_slug: "Sets its own slug, which the editor can't keep.",
  invalid: "Its frontmatter isn't valid, so the editor can't open it.",
  too_large: "Too large for the editor.",
  bad_path: "Its file name isn't a dated post name, so the editor can't handle it.",
  binary: "Not a text file.",
};

/** What to tell the owner about a refused publishing request. */
export interface ErrorText {
  text: string;
  /** Every problem the Worker found, one per line (`invalid_post`). */
  lines?: string[];
  /** The other draft that holds the address (`slug_in_use`). */
  draftId?: string;
}

const SLUG_TAKEN: Record<string, string> = {
  main: "on the site",
  pull_request: "by an open PR",
  draft: "by another draft",
};

/** The message for an error from any publishing call (design doc §4.9.7, contract §10.2). */
export function describePublishError(error: unknown): ErrorText {
  if (!(error instanceof ApiError)) {
    return { text: "Couldn't reach the server. Check your connection and try again." };
  }
  // Access answers an expired session with a 401; adminFetch has already shown the sign-in banner.
  if (error.status === 401) return { text: "Your session expired. Sign in again, then try again." };
  const details = error.details ?? {};
  switch (error.code) {
    case "stale_draft":
      return {
        text: "This draft changed in another tab. It has been reloaded; check it and publish again.",
      };
    case "changed_on_github":
      return {
        text:
          details.sha === null
            ? "This post isn't on GitHub's main branch any more."
            : "This post changed on GitHub since you loaded it.",
      };
    case "changed_on_github_open_pr":
      return {
        text:
          "This post changed on GitHub while your PR is open. Cancel the PR, then load the " +
          "GitHub version.",
      };
    case "branch_changed":
      return {
        text:
          "The PR's branch changed on GitHub. Merge the PR as it is, or cancel it and publish " +
          "again.",
      };
    case "pr_not_open":
      return { text: "The pull request isn't open any more, so nothing was pushed." };
    case "publishing":
      return { text: "A pull request is already open for this draft." };
    case "pr_mismatch":
      return { text: "The pull request on GitHub doesn't match this draft. Check it on GitHub." };
    case "unpublishing":
      return { text: "An unpublish PR is open for this post." };
    case "not_publishing":
      return { text: "This draft has no open pull request." };
    case "already_merged":
      return { text: "The pull request is already merged, so it can't be cancelled." };
    case "invalid_post": {
      const lines = Array.isArray(details.errors)
        ? details.errors.filter((line): line is string => typeof line === "string")
        : [];
      return { text: "Fix these before publishing:", lines };
    }
    case "unsupported_post":
      return {
        text:
          details.problem === "draft"
            ? "This file is marked draft on GitHub, so the editor can't publish it."
            : details.problem === "custom_slug"
              ? "This file sets its own slug, which the editor can't keep."
              : "This file isn't one the editor can handle.",
      };
    case "images_not_ready":
      return { text: "Some images haven't finished uploading." };
    case "slug_taken": {
      const where = typeof details.where === "string" ? SLUG_TAKEN[details.where] : undefined;
      return { text: `That address is already used${where ? ` ${where}` : ""}. Choose another.` };
    }
    case "slug_in_use":
      return {
        text: "Another draft uses this address.",
        ...(typeof details.draftId === "string" && { draftId: details.draftId }),
      };
    case "no_changes":
      return { text: "Nothing changed since the version on GitHub." };
    case "owner_email":
      return {
        text: "This post contains your private e-mail address. Remove it and publish again.",
      };
    case "github_error":
      return { text: "GitHub didn't answer as expected. Try again in a minute." };
    case "github_unavailable":
    case "misconfigured":
      return { text: "Publishing isn't available right now." };
    case "internal_error":
      return { text: "Something went wrong on the server. Try again." };
    default:
      // The Worker's own message: a plain sentence with no post content.
      return { text: error.message };
  }
}
