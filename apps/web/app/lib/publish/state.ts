// Shapes the publishing API returns (design doc §4.9.2, §4.9.7), shared by the Worker that builds
// them and the editor that shows them.

/** Where a draft's pull request is, from opened to live. */
export type Stage =
  | "draft"
  | "opened"
  | "ci_running"
  | "ci_failed"
  | "review"
  | "merged"
  | "deploying"
  | "deploy_failed"
  | "live"
  | "closed";

/** A draft's publishing status, as `GET /api/admin/drafts/:id/status` answers it. */
export interface PublishState {
  stage: Stage;
  action: "publish" | "unpublish" | null;
  pr: number | null;
  /** `pullUrl(pr)`. */
  prUrl: string | null;
  branch: string | null;
  /** A GitHub Actions run, only ever through `safeRunUrl`. */
  runUrl: string | null;
  mergeSha: string | null;
  slug: string | null;
  /** GitHub merged a version other than the last one published. */
  mergedOtherVersion: boolean;
}

/** Why a post on `main` can't be edited in the editor. */
export type PostProblem = "draft" | "custom_slug" | "invalid" | "too_large" | "bad_path" | "binary";

/** A post file on `main`, as `GET /api/admin/posts` lists it. */
export interface PostOnMain {
  /** The URL slug: the frontmatter `slug`, else the one from the file name. */
  slug: string;
  path: string;
  /** Blob SHA of the file on `main`. */
  sha: string;
  /** Frontmatter values, when the frontmatter parses. */
  title: string | null;
  date: string | null;
  updated: string | null;
  /** `postUrl(slug)`. */
  url: string;
  /** `problem === null`. */
  editable: boolean;
  problem: PostProblem | null;
  /** The draft that tracks this post, if any. */
  draft: { id: string; status: string; prNumber: number | null; prAction: string | null } | null;
}

/** Whether polling can stop: nothing more happens to the draft without the owner. */
export function isTerminal(stage: Stage): boolean {
  return stage === "draft" || stage === "live" || stage === "closed";
}
