import { mentionedFigureSrcs } from "../app/lib/publish/figures";
import { parsePostFile } from "../app/lib/publish/post-parse";
import {
  dateFromPath,
  isBranch,
  isGitSha,
  pullUrl,
  safeRunUrl,
} from "../app/lib/publish/post-path";
import type { PublishState, Stage } from "../app/lib/publish/state";
import {
  GitHubError,
  REPO_FULL_NAME,
  createGitHub,
  type DeployRun,
  type GitHub,
  type PullRequestStatus,
} from "./github";
import { markPublishedStatement } from "./images";
import { logPublishingError, publishError, publishJson, type PublishEnv } from "./publish-http";

// Where a draft's pull request is, from opened to live (design doc §4.9.7, execution plan Step
// 10.10), and the D1 changes each stage brings. One GraphQL query answers everything up to the
// merge; after it, only the deploy is checked. Every write is guarded on the PR number read at
// the start, so a poll that races a cancel or a new publish changes nothing.

/** A draft row with the columns publishing reads. */
export interface PublishRow {
  id: string;
  kind: "new" | "edit";
  source_path: string | null;
  base_sha: string | null;
  slug: string | null;
  title: string;
  summary: string;
  category: string | null;
  tags: string;
  cover_key: string | null;
  body_md: string;
  rev: number;
  status: string;
  pr_number: number | null;
  pr_branch: string | null;
  head_sha: string | null;
  merge_sha: string | null;
  pr_action: "publish" | "unpublish" | null;
  pr_blob_sha: string | null;
  post_date: string | null;
  publish_error: string | null;
  published_at: number | null;
}

const PUBLISH_COLUMNS =
  "id, kind, source_path, base_sha, slug, title, summary, category, tags, cover_key, body_md, " +
  "rev, status, pr_number, pr_branch, head_sha, merge_sha, pr_action, pr_blob_sha, post_date, " +
  "publish_error, published_at";

/** The draft `id`, or null. */
export function readPublishRow(db: D1Database, id: string): Promise<PublishRow | null> {
  return db
    .prepare(`SELECT ${PUBLISH_COLUMNS} FROM drafts WHERE id = ?`)
    .bind(id)
    .first<PublishRow>();
}

/**
 * Puts a draft back to Draft after its PR closed without a merge (or was cancelled). A new post
 * forgets its path, and its slug too unless it ever went live, so it can still be renamed.
 */
export function resetStatement(db: D1Database, id: string, prNumber: number) {
  return db
    .prepare(
      "UPDATE drafts SET status = 'draft', pr_number = NULL, pr_branch = NULL, head_sha = NULL, " +
        "merge_sha = NULL, pr_action = NULL, pr_blob_sha = NULL, publish_error = NULL, " +
        "slug = CASE WHEN kind = 'new' AND published_at IS NULL THEN NULL ELSE slug END, " +
        "source_path = CASE WHEN kind = 'new' THEN NULL ELSE source_path END, " +
        "post_date = CASE WHEN kind = 'new' THEN NULL ELSE post_date END " +
        "WHERE id = ? AND pr_number = ? RETURNING slug",
    )
    .bind(id, prNumber);
}

/** Whether GitHub merged a file other than the last one the editor pushed. */
function mergedOtherVersion(row: PublishRow): boolean {
  return (
    row.pr_action === "publish" &&
    row.merge_sha !== null &&
    row.pr_blob_sha !== null &&
    row.base_sha !== row.pr_blob_sha
  );
}

/** The state of `row` at `stage`. */
export function stateOf(row: PublishRow, stage: Stage, runUrl: string | null = null): PublishState {
  return {
    stage,
    action: row.pr_action,
    pr: row.pr_number,
    prUrl: row.pr_number === null ? null : pullUrl(row.pr_number),
    branch: row.pr_branch,
    runUrl,
    mergeSha: row.merge_sha,
    slug: row.slug,
    mergedOtherVersion: mergedOtherVersion(row),
  };
}

/** A draft with no pull request. */
export function draftState(slug: string | null): PublishState {
  return {
    stage: "draft",
    action: null,
    pr: null,
    prUrl: null,
    branch: null,
    runUrl: null,
    mergeSha: null,
    slug,
    mergedOtherVersion: false,
  };
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * The stage of a PR that isn't known to be merged. `write: false` when GitHub's head isn't the
 * one D1 recorded (a republish GitHub hasn't caught up with, or someone pushed), so its checks
 * say nothing about this draft.
 */
export function derivePrStage(
  pr: null | { state: "OPEN" | "CLOSED" | "MERGED"; headRefOid: string },
  dbHeadSha: string,
  ci: null | { status: string; conclusion: string | null; detailsUrl: string | null },
): { stage: Stage | "merged"; runUrl: string | null; write: boolean } {
  if (pr === null || pr.state === "CLOSED") return { stage: "closed", runUrl: null, write: true };
  if (pr.state === "MERGED") return { stage: "merged", runUrl: null, write: true };
  if (pr.headRefOid !== dbHeadSha) return { stage: "opened", runUrl: null, write: false };
  if (ci === null) return { stage: "opened", runUrl: null, write: true };
  if (ci.status !== "COMPLETED") return { stage: "ci_running", runUrl: null, write: true };
  if (PASSED.has(ci.conclusion ?? "")) return { stage: "review", runUrl: null, write: true };
  return { stage: "ci_failed", runUrl: safeRunUrl(ci.detailsUrl), write: true };
}

/**
 * The stage after the merge. A cancelled run was superseded in the deploy concurrency group, so
 * it isn't a failure: a later deploy ships the merge too, and `live` sees it through compare.
 */
export function deriveDeployStage(
  live: boolean,
  run: null | { status: string; conclusion: string | null; html_url: string },
): { stage: Stage; runUrl: string | null } {
  if (live) return { stage: "live", runUrl: null };
  if (run === null) return { stage: "merged", runUrl: null };
  if (run.status !== "completed") return { stage: "deploying", runUrl: safeRunUrl(run.html_url) };
  if (run.conclusion === "success") return { stage: "live", runUrl: null };
  if (run.conclusion === "cancelled") return { stage: "deploying", runUrl: null };
  return { stage: "deploy_failed", runUrl: safeRunUrl(run.html_url) };
}

const prMismatch = () =>
  publishError(502, "pr_mismatch", "The pull request on GitHub doesn't match this draft.");

/** Whether GitHub's PR is the one this draft opened: our branch, this repo, into `main`. */
function isOurPull(pr: NonNullable<PullRequestStatus["pullRequest"]>, row: PublishRow): boolean {
  return (
    pr.headRefName === row.pr_branch &&
    pr.headRepository === REPO_FULL_NAME &&
    pr.baseRefName === "main" &&
    isGitSha(pr.headRefOid) &&
    (pr.mergeCommit === null || isGitSha(pr.mergeCommit.oid))
  );
}

/** `GET /api/admin/drafts/:id/status`. */
export async function publishStatus(
  request: Request,
  env: PublishEnv,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  const db = env.DB;
  const row = await readPublishRow(db, id);
  if (!row) return publishError(404, "not_found", "No such draft.");
  if (row.status === "published") {
    return publishJson({ ...stateOf(row, "live"), action: row.pr_action ?? "publish" });
  }
  if ((row.status !== "publishing" && row.status !== "failed") || row.pr_number === null) {
    return publishJson(draftState(row.slug));
  }
  const github = createGitHub(env, request.url);
  let current = row;
  if (row.merge_sha === null) {
    const result = await pullRequestStep(github, db, ctx, row, row.pr_number);
    if (result instanceof Response) return result;
    current = result;
  }
  return deployStep(github, db, current, row.pr_number);
}

/** Up to the merge. Returns the response, or the row as the merge left it. */
async function pullRequestStep(
  github: GitHub,
  db: D1Database,
  ctx: ExecutionContext,
  row: PublishRow,
  prNumber: number,
): Promise<Response | PublishRow> {
  const branch = row.pr_branch;
  if (!isGitSha(row.head_sha) || row.source_path === null || branch === null) {
    throw new Error("a publishing draft without its head or path");
  }
  const { pullRequest: pr, ci } = await github.publishStatus({
    number: prNumber,
    head: row.head_sha,
    path: row.source_path,
  });
  if (pr && !isOurPull(pr, row)) return prMismatch();
  const derived = derivePrStage(pr, row.head_sha, ci);

  if (derived.stage === "closed") {
    const reset = await resetStatement(db, row.id, prNumber).first<{ slug: string | null }>();
    // The branch goes too, so the closed PR can't be reopened and merged behind D1's back.
    if (isBranch(branch)) ctx.waitUntil(deleteBranch(github, branch));
    return publishJson({ ...stateOf(row, "closed"), slug: reset ? reset.slug : row.slug });
  }
  if (derived.stage === "merged" && pr) return recordMerge(db, row, prNumber, pr);

  if (derived.stage === "ci_failed") {
    if (row.publish_error !== derived.runUrl) {
      await db
        .prepare(
          "UPDATE drafts SET publish_error = ? WHERE id = ? AND pr_number = ? " +
            "AND publish_error IS NOT ?",
        )
        .bind(derived.runUrl, row.id, prNumber, derived.runUrl)
        .run();
    }
  } else if (derived.write && row.publish_error !== null) {
    await db
      .prepare(
        "UPDATE drafts SET publish_error = NULL WHERE id = ? AND pr_number = ? " +
          "AND publish_error IS NOT NULL",
      )
      .bind(row.id, prNumber)
      .run();
  }
  return publishJson(stateOf(row, derived.stage, derived.runUrl));
}

/**
 * The first poll that sees the merge records it and, in the same batch, marks the images the
 * merged file mentions published, so either both happen or neither does and the next poll
 * tries again. Without the merged text (too large to read), every publish revision's images are
 * marked instead: marking too many only keeps them.
 */
async function recordMerge(
  db: D1Database,
  row: PublishRow,
  prNumber: number,
  pr: NonNullable<PullRequestStatus["pullRequest"]>,
): Promise<Response | PublishRow> {
  const merge = pr.mergeCommit;
  if (!merge) return prMismatch();
  if (row.pr_action === "unpublish") {
    await db
      .prepare(
        "UPDATE drafts SET merge_sha = ?, kind = 'new', source_path = NULL, base_sha = NULL, " +
          "post_date = NULL WHERE id = ? AND pr_number = ? AND merge_sha IS NULL",
      )
      .bind(merge.oid, row.id, prNumber)
      .run();
    return {
      ...row,
      merge_sha: merge.oid,
      kind: "new",
      source_path: null,
      base_sha: null,
      post_date: null,
    };
  }

  const file = merge.file;
  if (!file || !isGitSha(file.oid)) return prMismatch();
  const text = file.text !== null && !file.isTruncated ? file.text : null;
  const srcs = text !== null ? mentionedFigureSrcs(text) : await publishedRevisionSrcs(db, row.id);
  const parsed = text !== null ? parsePostFile(text) : null;
  const date = parsed?.ok
    ? parsed.post.date
    : (row.post_date ?? dateFromPath(row.source_path ?? ""));
  await db.batch([
    db
      .prepare(
        "UPDATE drafts SET merge_sha = ?, kind = 'edit', base_sha = ?, post_date = ? " +
          "WHERE id = ? AND pr_number = ? AND merge_sha IS NULL",
      )
      .bind(merge.oid, file.oid, date, row.id, prNumber),
    markPublishedStatement(db, srcs, { draftId: row.id, mergeSha: merge.oid }),
  ]);
  return { ...row, merge_sha: merge.oid, kind: "edit", base_sha: file.oid, post_date: date };
}

/** Image keys mentioned in any `publish` revision of the draft. */
async function publishedRevisionSrcs(db: D1Database, id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT body_md FROM draft_revisions WHERE draft_id = ? AND reason = 'publish'")
    .bind(id)
    .all<{ body_md: string }>();
  return [...new Set(results.flatMap((revision) => mentionedFigureSrcs(revision.body_md)))];
}

/**
 * After the merge: live when the site serves the merge commit or a later commit that contains
 * it, or when the merge's own deploy succeeded; otherwise the deploy run's stage.
 */
async function deployStep(
  github: GitHub,
  db: D1Database,
  row: PublishRow,
  prNumber: number,
): Promise<Response> {
  const mergeSha = row.merge_sha;
  if (!isGitSha(mergeSha)) throw new Error("a merged draft without a merge SHA");
  const live = await isLive(github, mergeSha);
  const run: DeployRun | null = live ? null : await github.deployRuns(mergeSha);
  const { stage, runUrl } = deriveDeployStage(live, run);

  if (stage === "live" && row.pr_action === "unpublish") {
    const state = stateOf(row, "live");
    await db
      .prepare(
        "UPDATE drafts SET status = 'draft', pr_number = NULL, pr_branch = NULL, " +
          "head_sha = NULL, merge_sha = NULL, pr_action = NULL, pr_blob_sha = NULL, " +
          "publish_error = NULL WHERE id = ? AND pr_number = ?",
      )
      .bind(row.id, prNumber)
      .run();
    return publishJson(state);
  }
  if (stage === "live") {
    await db
      .prepare(
        "UPDATE drafts SET status = 'published', published_at = ?, pr_branch = NULL, " +
          "head_sha = NULL, publish_error = NULL WHERE id = ? AND pr_number = ?",
      )
      .bind(Date.now(), row.id, prNumber)
      .run();
    return publishJson({ ...stateOf(row, "live"), action: "publish", branch: null });
  }
  if (stage === "deploy_failed" && (row.status !== "failed" || row.publish_error !== runUrl)) {
    await db
      .prepare(
        "UPDATE drafts SET status = 'failed', publish_error = ? WHERE id = ? AND pr_number = ? " +
          "AND (status != 'failed' OR publish_error IS NOT ?)",
      )
      .bind(runUrl, row.id, prNumber, runUrl)
      .run();
  }
  return publishJson(stateOf(row, stage, runUrl));
}

/** Whether the site serves `mergeSha`, or a later commit on top of it. */
async function isLive(github: GitHub, mergeSha: string): Promise<boolean> {
  const version = await github.liveVersion();
  if (version === mergeSha) return true;
  if (!isGitSha(version)) return false;
  try {
    const status = await github.compare(mergeSha, version);
    return status === "ahead" || status === "identical";
  } catch (error) {
    // A version GitHub doesn't know (a local build) says nothing either way.
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

/** Best effort: a failure is logged by kind and otherwise ignored. */
async function deleteBranch(github: GitHub, branch: string): Promise<void> {
  try {
    await github.deleteRef(branch);
  } catch (error) {
    logPublishingError(error);
  }
}
