import { postFile, slugify } from "../app/lib/admin/post-file";
import { figureSrcsOf, lintFigures, mentionedFigureSrcs } from "../app/lib/publish/figures";
import { gitBlobSha } from "../app/lib/publish/git-blob";
import {
  parsePostFile,
  samePost,
  snapshotOf,
  type PostSnapshot,
} from "../app/lib/publish/post-parse";
import {
  branchName,
  dateFromPath,
  isBranchForSlug,
  isIsoDate,
  isPostPath,
  isSlug,
  postPath,
  pullUrl,
  slugFromPath,
} from "../app/lib/publish/post-path";
import { buildPullRequest, buildRepublishComment } from "../app/lib/publish/pr-text";
import type { PublishState } from "../app/lib/publish/state";
import { methodNotAllowed } from "./api";
import { DRAFT_ID, MAX_BODY_BYTES, readJson } from "./drafts";
import {
  GitHubError,
  GitHubUnavailable,
  OwnerEmailInBody,
  REPO_FULL_NAME,
  containsOwnerEmail,
  createGitHub,
  ownerEmailOf,
  type GitHub,
  type Identity,
  type RepoFile,
  type TreeEntry,
} from "./github";
import { importPost, insertImportedDraft, listPosts, postsOnMain } from "./posts";
import {
  Refusal,
  logPublishingError,
  publishError,
  publishJson,
  refuse,
  type PublishEnv,
} from "./publish-http";
import { publishStatus, readPublishRow, resetStatement, type PublishRow } from "./publish-status";

// Publishing from the editor (design doc §4.9.7, execution plan Steps 10.9 and 10.10): one commit
// on a `blog/<slug>-<time>` branch and a pull request the owner reviews and merges. The Worker
// never merges. Everything the flow will send is built and checked (the post, the figures, the
// owner's address in every text) before the first GitHub write; D1 is written last, in one
// guarded batch, and a flow that fails after pushing its branch closes the PR and deletes the
// branch again. Nothing here logs a path, a slug, a title, a body or a draft id.

const DRAFT_ROUTE = /^\/api\/admin\/drafts\/([^/]+)\/(publish|status|cancel)$/;
const POSTS_ROUTE = /^\/api\/admin\/posts(?:\/([^/]+)\/(import|unpublish))?$/;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Routes the publishing API: publish, status and cancel under a draft, and the posts on `main`
 * with import and unpublish. Returns null for any other path. Every error becomes a JSON answer
 * here. Writes run under `ctx.waitUntil`, so a client that goes away can't stop a flow between
 * GitHub and D1.
 */
export async function handlePublishing(
  request: Request,
  env: PublishEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  const draft = DRAFT_ROUTE.exec(pathname);
  if (draft) {
    const [, id = "", action] = draft;
    if (!DRAFT_ID.test(id)) return draftNotFound();
    if (action === "status") {
      return method === "GET"
        ? answer(() => publishStatus(request, env, ctx, id))
        : methodNotAllowed("GET");
    }
    if (method !== "POST") return methodNotAllowed("POST");
    const flow = action === "publish" ? publishDraft : cancelPublish;
    return inBackground(ctx, () => flow(request, env, id));
  }

  const posts = POSTS_ROUTE.exec(pathname);
  if (!posts) return null;
  const [, slug, action] = posts;
  if (slug === undefined) {
    return method === "GET" ? answer(() => listPosts(request, env)) : methodNotAllowed("GET");
  }
  if (!isSlug(slug)) return publishError(404, "not_found", "No published post with that address.");
  if (method !== "POST") return methodNotAllowed("POST");
  if (action === "import") return answer(() => importPost(request, env, slug));
  return inBackground(ctx, () => unpublishPost(request, env, slug));
}

/** Runs a handler and turns anything it throws into the API's error answer. */
async function answer(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return failure(error);
  }
}

/** `answer`, kept alive by the runtime until it finishes even if the client disconnects. */
function inBackground(ctx: ExecutionContext, handler: () => Promise<Response>): Promise<Response> {
  const result = answer(handler);
  ctx.waitUntil(result.catch(() => {}));
  return result;
}

function failure(error: unknown): Response {
  if (error instanceof Refusal) return error.response;
  logPublishingError(error);
  if (error instanceof GitHubUnavailable) {
    return publishError(503, error.code, "Publishing isn't available right now.");
  }
  if (error instanceof GitHubError) {
    return publishError(502, "github_error", "GitHub didn't answer as expected.");
  }
  if (error instanceof OwnerEmailInBody) return ownerEmailError();
  return publishError(500, "internal_error", "Something went wrong.");
}

// ---- Refusals ----

const draftNotFound = () => publishError(404, "not_found", "No such draft.");
const badRequest = (message: string) => publishError(400, "bad_request", message);
const ownerEmailError = () =>
  publishError(422, "owner_email", "This post contains the owner's private e-mail address.");
const invalidPost = (errors: string[]) =>
  refuse(422, "invalid_post", "The post can't be published as it is.", { errors });
const unsupported = (problem: string) =>
  refuse(422, "unsupported_post", "The editor can't publish this file.", { problem });
const slugTaken = (where: "main" | "pull_request" | "draft", pr?: number) =>
  refuse(422, "slug_taken", "That address is already used.", {
    where,
    ...(pr !== undefined && { pr }),
  });
const alreadyPublishing = () =>
  refuse(409, "publishing", "A pull request for this draft is already open.");
const prMismatch = () =>
  refuse(409, "pr_mismatch", "The pull request on GitHub doesn't match this draft.");
const noChanges = () => refuse(422, "no_changes", "Nothing changed since the version on GitHub.");

/** Refuses with `owner_email` if any of `texts` holds the owner's address. */
function checkOwnerEmail(ownerEmail: string, texts: string[]): void {
  if (texts.some((text) => containsOwnerEmail(text, ownerEmail))) {
    throw new Refusal(ownerEmailError());
  }
}

const identityText = (identity: Identity) => `${identity.name} <${identity.email}>`;

// ---- Publish ----

interface PublishInput {
  baseRev: number;
  date: string;
  slug?: string;
}

/** `{baseRev, date, slug?}`, with `date` the browser's local date (at most a day off UTC). */
function parsePublishInput(body: Record<string, unknown>, now: number): PublishInput | Response {
  const unknown = Object.keys(body).filter((key) => !["baseRev", "date", "slug"].includes(key));
  if (unknown.length > 0) return badRequest(`Unknown field: ${unknown.join(", ")}.`);
  const { baseRev, date, slug } = body;
  if (!Number.isSafeInteger(baseRev) || (baseRev as number) < 1) {
    return badRequest("baseRev must be a positive integer.");
  }
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  if (!isIsoDate(date) || Math.abs(Date.parse(`${date}T00:00:00Z`) - today) > DAY) {
    return badRequest("date must be today's date as YYYY-MM-DD.");
  }
  if (slug !== undefined && !isSlug(slug)) {
    return badRequest("slug must be lowercase letters, digits and dashes, at most 80 characters.");
  }
  return { baseRev: baseRev as number, date, ...(slug !== undefined && { slug }) };
}

/** The post fields of a draft row, as `postFile` and `snapshotOf` take them. */
function fieldsOf(row: PublishRow, slug: string) {
  return {
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    bodyMd: row.body_md,
    slug,
    cover: row.cover_key,
  };
}
type PostFields = ReturnType<typeof fieldsOf>;

/** Everything a publish flow works from. */
interface Flow {
  db: D1Database;
  row: PublishRow;
  input: PublishInput;
  slug: string;
  fields: PostFields;
  ownerEmail: string;
}

/**
 * The file the draft publishes, checked as the build would check it: frontmatter, figure lines,
 * size and path. Throws `invalid_post` with every problem.
 */
function buildFile(fields: PostFields, date: string, updated: string | undefined, path: string) {
  const file = postFile(fields, date, updated === undefined ? {} : { updated });
  const errors = file.ok ? [] : [...file.errors];
  for (const { line, message } of lintFigures(fields.bodyMd).errors) {
    errors.push(`line ${line}: ${message}`);
  }
  if (new TextEncoder().encode(fields.bodyMd).byteLength > MAX_BODY_BYTES) {
    errors.push(`The body can be at most ${MAX_BODY_BYTES / 1024} KB.`);
  }
  if (!isPostPath(path)) errors.push("The post's file isn't a valid post path.");
  if (!file.ok || errors.length > 0) throw invalidPost(errors);
  return { path, content: file.content };
}

/**
 * Refuses unless every image the body shows is uploaded (or already published). Images the
 * version on `main` already shows are exempt: they are live, whatever their row says.
 */
async function checkImages(db: D1Database, body: string, exempt: string[] = []): Promise<void> {
  const skip = new Set(exempt);
  const srcs = figureSrcsOf(body).filter((src) => !skip.has(src));
  if (srcs.length === 0) return;
  const { results } = await db
    .prepare(
      "SELECT 'blog/' || id || '.' || ext AS src FROM images " +
        "WHERE id IN (SELECT substr(value, 6, 36) FROM json_each(?)) " +
        "AND (state = 'ready' OR published = 1)",
    )
    .bind(JSON.stringify(srcs))
    .all<{ src: string }>();
  const ready = new Set(results.map((image) => image.src));
  const missing = srcs.filter((src) => !ready.has(src));
  if (missing.length > 0) {
    throw refuse(422, "images_not_ready", "Some images haven't finished uploading.", {
      srcs: missing,
    });
  }
}

/**
 * The post on `main` an edit replaces: refused when it moved since the draft loaded it (`base_sha`),
 * or when it is a file the editor mustn't write over (a draft, or one with its own slug).
 */
function previousPost(
  file: RepoFile | null,
  baseSha: string | null,
  path: string,
  changed: "changed_on_github" | "changed_on_github_open_pr",
): PostSnapshot {
  const message =
    changed === "changed_on_github"
      ? "This post changed on GitHub since you loaded it."
      : "This post changed on GitHub while the pull request is open.";
  if (!file) throw refuse(409, changed, message, { sha: null });
  if (file.sha !== baseSha) throw refuse(409, changed, message, { sha: file.sha });
  if (file.text === null) throw unsupported(file.problem ?? "too_large");
  const parsed = parsePostFile(file.text);
  if (!parsed.ok) throw invalidPost(parsed.errors.map((error) => `On GitHub: ${error}`));
  if (parsed.draft) throw unsupported("draft");
  if (parsed.frontmatterSlug !== undefined && parsed.frontmatterSlug !== slugFromPath(path)) {
    throw unsupported("custom_slug");
  }
  return parsed.post;
}

/** `POST /api/admin/drafts/:id/publish`. */
async function publishDraft(request: Request, env: PublishEnv, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const input = parsePublishInput(body, Date.now());
  if (input instanceof Response) return input;

  const db = env.DB;
  const row = await readPublishRow(db, id);
  if (!row) return draftNotFound();
  if (row.rev !== input.baseRev) {
    return publishError(409, "stale_draft", "This draft changed in another tab.", { rev: row.rev });
  }
  const open = row.status === "publishing" && row.merge_sha === null;
  if (open && row.pr_action === "unpublish") {
    return publishError(409, "unpublishing", "An unpublish pull request is open for this post.");
  }
  if (open && row.pr_action !== "publish") throw alreadyPublishing();

  const slug = row.slug ?? input.slug ?? slugify(row.title);
  if (!isSlug(slug)) {
    throw invalidPost([
      "The address must be lowercase letters, digits and dashes, at most 80 characters.",
    ]);
  }
  if (row.slug === null) {
    const taken = await db
      .prepare("SELECT 1 AS taken FROM drafts WHERE slug = ? AND id != ?")
      .bind(slug, id)
      .first();
    if (taken) throw slugTaken("draft");
  }
  const ownerEmail = ownerEmailOf(env);
  if (!ownerEmail) throw new GitHubUnavailable("misconfigured");

  // Everything that can be checked without GitHub, before the first call.
  const fields = fieldsOf(row, slug);
  const isNew = row.kind === "new" && !open;
  if (!isNew && (row.source_path === null || !isPostPath(row.source_path))) {
    throw invalidPost(["The post's file isn't a valid post path."]);
  }
  const path = isNew ? postPath(input.date, slug) : (row.source_path as string);
  const provisional = buildFile(
    fields,
    isNew ? input.date : dateFromPath(path),
    row.kind === "edit" ? input.date : undefined,
    path,
  );
  if (row.kind === "new") await checkImages(db, row.body_md);
  checkOwnerEmail(ownerEmail, [provisional.content]);

  const github = createGitHub(env, request.url);
  const flow: Flow = { db, row, input, slug, fields, ownerEmail };
  if (open) return republish(flow, github, path);
  return row.kind === "edit" ? publishEdit(flow, github, path) : publishNew(flow, github, path);
}

/** The first PR for a new post: its slug must be free on `main` and among open PRs. */
async function publishNew(flow: Flow, github: GitHub, path: string): Promise<Response> {
  const { row, slug, input } = flow;
  const committer = await github.botIdentity();
  const main = await mainHead(github);
  const { tree } = await github.getCommit(main);
  const { posts } = await postsOnMain(github);
  if (posts.some((post) => post.slug === slug)) throw slugTaken("main");
  const pull = (await github.openPullHeads()).find(
    (head) =>
      !head.isCrossRepository &&
      isBranchForSlug(head.headRefName, slug) &&
      head.headRefName !== row.pr_branch,
  );
  if (pull) throw slugTaken("pull_request", pull.number);

  const file = buildFile(flow.fields, input.date, undefined, path);
  const post = snapshotOf(flow.fields, input.date);
  const pr = buildPullRequest({ kind: "publish", slug, path, post });
  return openPublishPull(flow, github, { file, pr, committer, main, tree });
}

/** The first PR for a post on `main`: an `Update:` that keeps its `date` and sets `updated`. */
async function publishEdit(flow: Flow, github: GitHub, path: string): Promise<Response> {
  const { row, slug, input, ownerEmail } = flow;
  const committer = await github.botIdentity();
  const main = await mainHead(github);
  const { tree } = await github.getCommit(main);
  const onMain = await github.getFile(path, main);
  const previous = previousPost(onMain, row.base_sha, path, "changed_on_github");

  const date = previous.date;
  const updated = input.date;
  const file = buildFile(flow.fields, date, updated, path);
  const next = snapshotOf(flow.fields, date, updated);
  if ((await gitBlobSha(file.content)) === onMain?.sha || samePost(previous, next)) {
    throw noChanges();
  }
  await checkImages(flow.db, row.body_md, mentionedFigureSrcs(previous.body));
  const isPrivate = (text: string) => containsOwnerEmail(text, ownerEmail);
  const pr = buildPullRequest({ kind: "update", slug, path, post: next, previous, isPrivate });
  return openPublishPull(flow, github, { file, pr, committer, main, tree });
}

/** Opens the PR for a publish and records it with a `publish` revision of what it pushed. */
async function openPublishPull(
  flow: Flow,
  github: GitHub,
  change: {
    file: { path: string; content: string };
    pr: { title: string; body: string };
    committer: Identity;
    main: string;
    tree: string;
  },
): Promise<Response> {
  const { db, row, slug } = flow;
  const { file } = change;
  const blobSha = await gitBlobSha(file.content);
  const opened = await openPull(flow, github, {
    entry: { path: file.path, mode: "100644", type: "blob", content: file.content },
    content: file.content,
    ...change,
    claim: (number, branch, head) => [
      db
        .prepare(
          "UPDATE drafts SET status = 'publishing', slug = ?, source_path = ?, pr_number = ?, " +
            "pr_branch = ?, head_sha = ?, merge_sha = NULL, pr_action = 'publish', " +
            "pr_blob_sha = ?, publish_error = NULL " +
            "WHERE id = ? AND (status != 'publishing' OR merge_sha IS NOT NULL) RETURNING id",
        )
        .bind(slug, file.path, number, branch, head, blobSha, row.id),
      publishRevision(db, row, number, head),
    ],
  });
  return publishJson({ ...openedState(slug, opened, "publish"), republished: false }, 202);
}

/**
 * The `publish` revision: the row as it was read, kept only if this flow's claim won. A revision
 * already at that rev (an autosave snapshot of the same text) is marked `publish` instead.
 */
function publishRevision(db: D1Database, row: PublishRow, prNumber: number, head: string) {
  const meta = JSON.stringify({
    summary: row.summary,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    cover: row.cover_key,
  });
  return db
    .prepare(
      "INSERT INTO draft_revisions (draft_id, rev, title, body_md, meta, reason, created_at) " +
        "SELECT ?1, ?2, ?3, ?4, ?5, 'publish', ?6 WHERE EXISTS " +
        "(SELECT 1 FROM drafts WHERE id = ?1 AND pr_number = ?7 AND head_sha = ?8) " +
        "ON CONFLICT (draft_id, rev) DO UPDATE SET reason = 'publish'",
    )
    .bind(row.id, row.rev, row.title, row.body_md, meta, Date.now(), prNumber, head);
}

function openedState(
  slug: string,
  opened: { number: number; branch: string },
  action: "publish" | "unpublish",
): PublishState {
  return {
    stage: "opened",
    action,
    pr: opened.number,
    prUrl: pullUrl(opened.number),
    branch: opened.branch,
    runUrl: null,
    mergeSha: null,
    slug,
    mergedOtherVersion: false,
  };
}

/** `main`'s head commit. */
async function mainHead(github: GitHub): Promise<string> {
  const main = await github.getRef("main");
  if (main === null) throw new GitHubError(404, "GET /repos/:repo/git/ref/heads/:branch");
  return main;
}

/**
 * The writes of a new PR: tree, commit, branch, pull request, then the D1 claim. Every text it
 * sends is checked for the owner's address first. Once the branch exists, any failure (GitHub,
 * a lost race, D1) closes the PR and deletes the branch before the error is answered.
 */
async function openPull(
  flow: Pick<Flow, "db" | "slug" | "ownerEmail">,
  github: GitHub,
  change: {
    entry: TreeEntry;
    content: string;
    pr: { title: string; body: string };
    committer: Identity;
    main: string;
    tree: string;
    claim: (number: number, branch: string, head: string) => D1PreparedStatement[];
  },
): Promise<{ number: number; branch: string }> {
  const { db, slug, ownerEmail } = flow;
  const seconds = Math.floor(Date.now() / 1000);
  const branches = [branchName(slug, seconds), branchName(slug, seconds + 1)];
  checkOwnerEmail(ownerEmail, [
    ...branches,
    change.entry.path,
    change.content,
    change.pr.title,
    change.pr.body,
    identityText(github.author),
    identityText(change.committer),
  ]);

  const tree = await github.createTree(change.tree, [change.entry]);
  const head = await github.createCommit({
    message: change.pr.title,
    tree,
    parents: [change.main],
    author: github.author,
    committer: change.committer,
  });
  // One retry a second later if the branch name is taken.
  let branch: string | null = null;
  for (const name of branches) {
    if ((await github.createRef(name, head)) === "created") {
      branch = name;
      break;
    }
  }
  if (branch === null) throw new GitHubError(422, "POST /repos/:repo/git/refs");

  let number: number | null = null;
  try {
    number = await github.createPull({
      title: change.pr.title,
      head: branch,
      body: change.pr.body,
    });
    let claimed: boolean;
    try {
      const results = await db.batch(change.claim(number, branch, head));
      claimed = (results[0]?.results.length ?? 0) > 0;
    } catch (error) {
      if (/UNIQUE constraint failed: drafts\.slug/.test(String(error))) throw slugTaken("draft");
      throw error;
    }
    if (!claimed) throw alreadyPublishing();
    return { number, branch };
  } catch (error) {
    await cleanUp(github, number, branch);
    throw error;
  }
}

/** Best effort: closes the PR (if it was opened) and deletes its branch. */
async function cleanUp(github: GitHub, number: number | null, branch: string): Promise<void> {
  if (number !== null) {
    try {
      await github.updatePull(number, { state: "closed" });
    } catch (error) {
      logPublishingError(error);
    }
  }
  try {
    await github.deleteRef(branch);
  } catch (error) {
    logPublishingError(error);
  }
}

/**
 * Publishing again while the PR is open: a new commit on the same branch (never forced), D1
 * updated as soon as the branch moved, then the PR body refreshed and a comment saying what
 * changed since the previous publish (best effort).
 */
async function republish(flow: Flow, github: GitHub, path: string): Promise<Response> {
  const { db, row, slug, input, ownerEmail } = flow;
  const number = row.pr_number;
  const branch = row.pr_branch;
  const oldHead = row.head_sha;
  if (number === null || branch === null || oldHead === null) throw alreadyPublishing();

  const committer = await github.botIdentity();
  const pull = await github.getPull(number);
  if (pull.state !== "open") {
    throw refuse(409, "pr_not_open", "The pull request isn't open any more.");
  }
  if (pull.headRef !== branch || pull.headRepo !== REPO_FULL_NAME || pull.baseRef !== "main") {
    throw prMismatch();
  }
  // The branch itself, not the PR's head: GitHub moves a PR's head a little after a push, so
  // right after a republish the PR can still show the previous commit.
  const branchHead = await github.getRef(branch);
  if (branchHead === null) {
    throw refuse(409, "pr_not_open", "The pull request isn't open any more.");
  }
  if (branchHead !== oldHead) {
    throw refuse(409, "branch_changed", "The pull request's branch changed on GitHub.");
  }
  const { tree } = await github.getCommit(oldHead);

  let previous: PostSnapshot | undefined;
  let date = dateFromPath(path);
  let updated: string | undefined;
  if (row.kind === "edit") {
    const onMain = await github.getFile(path, "main");
    previous = previousPost(onMain, row.base_sha, path, "changed_on_github_open_pr");
    date = previous.date;
    updated = input.date;
  }
  const file = buildFile(flow.fields, date, updated, path);
  const next = snapshotOf(flow.fields, date, updated);
  const lastPublish = await lastPublishSnapshot(db, row.id, date, updated);
  const blobSha = await gitBlobSha(file.content);
  if (blobSha === row.pr_blob_sha || (lastPublish && samePost(lastPublish, next))) {
    throw noChanges();
  }
  if (previous) await checkImages(db, row.body_md, mentionedFigureSrcs(previous.body));

  const isPrivate = (text: string) => containsOwnerEmail(text, ownerEmail);
  const pr = previous
    ? buildPullRequest({ kind: "update", slug, path, post: next, previous, isPrivate })
    : buildPullRequest({ kind: "publish", slug, path, post: next });
  const comment = lastPublish ? buildRepublishComment(lastPublish, next, isPrivate) : null;
  checkOwnerEmail(ownerEmail, [
    branch,
    path,
    file.content,
    pr.title,
    pr.body,
    comment ?? "",
    identityText(github.author),
    identityText(committer),
  ]);

  const newTree = await github.createTree(tree, [
    { path, mode: "100644", type: "blob", content: file.content },
  ]);
  const head = await github.createCommit({
    message: pr.title,
    tree: newTree,
    parents: [oldHead],
    author: github.author,
    committer,
  });
  if ((await github.updateRef(branch, head)) === "not_fast_forward") {
    throw refuse(409, "branch_changed", "The pull request's branch changed on GitHub.");
  }

  // The branch has moved: record it at once, retrying a failed batch once. The new head matches
  // too, so a retry after a batch that committed but still answered an error counts.
  const record = () =>
    db.batch([
      db
        .prepare(
          "UPDATE drafts SET head_sha = ?, pr_blob_sha = ?, publish_error = NULL WHERE id = ? " +
            "AND status = 'publishing' AND pr_number = ? AND head_sha IN (?, ?) RETURNING id",
        )
        .bind(head, blobSha, row.id, number, oldHead, head),
      publishRevision(db, row, number, head),
    ]);
  const results = await record().catch(() => record());
  if ((results[0]?.results.length ?? 0) === 0) {
    throw refuse(409, "pr_not_open", "The pull request isn't open any more.");
  }

  // The commit is in the PR either way; a stale description only earns a warning.
  let described: boolean;
  try {
    described = (await github.updatePull(number, { title: pr.title, body: pr.body })).ok;
  } catch (error) {
    logPublishingError(error);
    described = false;
  }
  if (comment !== null) {
    try {
      await github.createComment(number, comment);
    } catch (error) {
      logPublishingError(error);
      described = false;
    }
  }
  const warnings = described ? [] : ["pr_not_updated"];
  return publishJson(
    {
      ...openedState(slug, { number, branch }, "publish"),
      republished: true,
      ...(warnings.length > 0 && { warnings }),
    },
    202,
  );
}

/** The newest `publish` revision as a post dated like the new version, or null. */
async function lastPublishSnapshot(
  db: D1Database,
  id: string,
  date: string,
  updated: string | undefined,
): Promise<PostSnapshot | null> {
  const revision = await db
    .prepare(
      "SELECT title, body_md, meta FROM draft_revisions WHERE draft_id = ? AND reason = 'publish' " +
        "ORDER BY rev DESC LIMIT 1",
    )
    .bind(id)
    .first<{ title: string; body_md: string; meta: string }>();
  if (!revision) return null;
  const meta = JSON.parse(revision.meta) as {
    summary?: string;
    category?: string | null;
    tags?: string[];
    cover?: string | null;
  };
  return snapshotOf(
    {
      title: revision.title,
      summary: meta.summary ?? "",
      category: meta.category ?? null,
      tags: meta.tags ?? [],
      bodyMd: revision.body_md,
      cover: meta.cover ?? null,
    },
    date,
    updated,
  );
}

// ---- Unpublish ----

/**
 * `POST /api/admin/posts/:slug/unpublish`: a PR that deletes the post's file, run on the post's
 * draft (made for it if it has none). Any post file on `main` can be unpublished, even one the
 * editor can't edit.
 */
async function unpublishPost(request: Request, env: PublishEnv, slug: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length > 0) return badRequest("Send an empty JSON object.");
  const ownerEmail = ownerEmailOf(env);
  const db = env.DB;
  const github = createGitHub(env, request.url);
  const committer = await github.botIdentity();

  const { posts } = await postsOnMain(github);
  const listed = posts.find((post) => post.slug === slug);
  if (!listed) return publishError(404, "not_found", "No published post with that address.");
  if (!isPostPath(listed.path)) throw unsupported("bad_path");
  const path = listed.path;

  const draftId = await unpublishDraft(db, listed, slug);
  const main = await mainHead(github);
  const { tree } = await github.getCommit(main);
  const file = await github.getFile(path, main);
  if (!file) {
    throw refuse(409, "changed_on_github", "This post isn't on GitHub's main branch any more.", {
      sha: null,
    });
  }
  const parsed = file.text === null ? null : parsePostFile(file.text);
  const post = parsed?.ok ? parsed.post : null;
  const pr = buildPullRequest({
    kind: "unpublish",
    slug,
    path,
    title: post?.title ?? null,
    date: post?.date ?? null,
    updated: post?.updated ?? null,
    isPrivate: (text) => containsOwnerEmail(text, ownerEmail),
  });

  const opened = await openPull({ db, slug, ownerEmail }, github, {
    entry: { path, mode: "100644", type: "blob", sha: null },
    content: "",
    pr,
    committer,
    main,
    tree,
    claim: (number, branch, head) => [
      db
        .prepare(
          "UPDATE drafts SET status = 'publishing', pr_number = ?, pr_branch = ?, head_sha = ?, " +
            "merge_sha = NULL, pr_action = 'unpublish', pr_blob_sha = NULL, publish_error = NULL " +
            "WHERE id = ? AND (status != 'publishing' OR merge_sha IS NOT NULL) RETURNING id",
        )
        .bind(number, branch, head, draftId),
    ],
  });
  return publishJson({ ...openedState(slug, opened, "unpublish"), draftId }, 202);
}

/**
 * The draft an unpublish runs on: the one with the post's path, else the post's edit draft,
 * else a new tracking draft like an import's. Refused while a PR for it is open, or when a new
 * post's draft holds the address.
 */
async function unpublishDraft(
  db: D1Database,
  listed: Parameters<typeof insertImportedDraft>[1],
  slug: string,
): Promise<string> {
  type Found = { id: string; status: string; merge_sha: string | null };
  const find = async () =>
    (await db
      .prepare(
        "SELECT id, status, merge_sha FROM drafts WHERE source_path = ? " +
          "ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(listed.path)
      .first<Found>()) ??
    (await db
      .prepare("SELECT id, status, merge_sha FROM drafts WHERE kind = 'edit' AND slug = ?")
      .bind(slug)
      .first<Found>());
  const slugHolder = async () => {
    const holder = await db
      .prepare("SELECT id FROM drafts WHERE slug = ?")
      .bind(slug)
      .first<{ id: string }>();
    if (holder) {
      throw refuse(409, "slug_in_use", "Another draft uses this address.", { draftId: holder.id });
    }
  };

  let draft = await find();
  if (!draft) {
    await slugHolder();
    // Another request may insert first; then its draft is the one.
    await insertImportedDraft(db, listed);
    draft = await find();
    if (!draft) await slugHolder();
  }
  if (!draft) throw new Error("an unpublish lost its draft");
  if (draft.status === "publishing" && draft.merge_sha === null) throw alreadyPublishing();
  return draft.id;
}

// ---- Cancel ----

/** `POST /api/admin/drafts/:id/cancel`: closes the PR, deletes its branch, back to Draft. */
async function cancelPublish(request: Request, env: PublishEnv, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length > 0) return badRequest("Send an empty JSON object.");
  const db = env.DB;
  const row = await readPublishRow(db, id);
  if (!row) return draftNotFound();
  const number = row.pr_number;
  if (row.status !== "publishing" || number === null) {
    return publishError(409, "not_publishing", "This draft has no open pull request.");
  }
  const alreadyMerged = () =>
    publishError(409, "already_merged", "The pull request is already merged.");
  if (row.merge_sha !== null) return alreadyMerged();

  const github = createGitHub(env, request.url);
  const isOurs = (pull: Awaited<ReturnType<GitHub["getPull"]>>) =>
    pull.headRef === row.pr_branch && pull.headRepo === REPO_FULL_NAME && pull.baseRef === "main";
  const pull = await github.getPull(number);
  if (!isOurs(pull)) throw prMismatch();
  if (pull.merged) return alreadyMerged();
  if (pull.state === "open") {
    const closed = await github.updatePull(number, { state: "closed" });
    if (!closed.ok || closed.merged) {
      // Merged in the meantime, or GitHub wouldn't close it: look again.
      const again = await github.getPull(number);
      if (again.merged) return alreadyMerged();
      if (again.state !== "closed") throw new GitHubError(422, "PATCH /repos/:repo/pulls/:n");
    }
  }
  if (row.pr_branch !== null) await github.deleteRef(row.pr_branch);
  const reset = await resetStatement(db, id, number).first<{ slug: string | null }>();
  return publishJson({
    stage: "draft",
    action: null,
    pr: null,
    prUrl: null,
    branch: null,
    runUrl: null,
    mergeSha: null,
    slug: reset ? reset.slug : row.slug,
    mergedOtherVersion: false,
  } satisfies PublishState);
}
