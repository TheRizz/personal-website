import { parsePostFile, type PostSnapshot } from "../app/lib/publish/post-parse";
import { isPostPath, postUrl, slugFromPath } from "../app/lib/publish/post-path";
import type { PostOnMain, PostProblem } from "../app/lib/publish/state";
import { MAX_BODY_BYTES, markImages, readJson, snapshot } from "./drafts";
import { createGitHub, type GitHub, type PostsTreeEntry } from "./github";
import { publishError, publishJson, type PublishEnv } from "./publish-http";

// The posts on `main` and the drafts that edit them (design doc §4.9.7 "Editing a published
// post"). One GraphQL query reads every file in content/blog with its text; the result is kept
// in the isolate by tree SHA, so later listings cost one small probe query and no parsing.
// Import turns a post into a draft (or finds the one it already has) without writing to GitHub,
// and refresh loads the GitHub version into that draft, keeping the replaced one as a revision.

/** A post on `main` as the listing keeps it: the API's fields and, when it parses, the post. */
export interface ListedPost extends Omit<PostOnMain, "draft"> {
  post: PostSnapshot | null;
}

/** The isolate's last listing. Only resolved values, never a promise, are kept across requests. */
let cache: { treeSha: string; posts: ListedPost[] } | null = null;

/** Forgets the cached listing. For tests. */
export function resetPostsCache(): void {
  cache = null;
}

/** What the build would make of one file, and why the editor can't take it, if it can't. */
function listedPost(entry: PostsTreeEntry): ListedPost {
  const path = `content/blog/${entry.name}`;
  const blob = entry.object;
  const readable =
    blob !== null && !blob.isBinary && !blob.isTruncated && blob.byteSize <= MAX_BODY_BYTES;
  const parsed = readable && blob.text !== null ? parsePostFile(blob.text) : null;
  const ok = parsed?.ok ? parsed : null;
  const fileSlug = slugFromPath(path);

  let problem: PostProblem | null = null;
  if (!isPostPath(path)) problem = "bad_path";
  else if (blob === null || blob.isBinary) problem = "binary";
  else if (!readable || blob.text === null) problem = "too_large";
  else if (!ok) problem = "invalid";
  else if (ok.draft) problem = "draft";
  else if (ok.frontmatterSlug !== undefined && ok.frontmatterSlug !== fileSlug) {
    problem = "custom_slug";
  }
  const slug = ok?.frontmatterSlug ?? fileSlug;
  return {
    slug,
    path,
    sha: entry.oid,
    title: ok?.post.title ?? null,
    date: ok?.post.date ?? null,
    updated: ok?.post.updated ?? null,
    url: postUrl(slug),
    editable: problem === null,
    problem,
    post: ok?.post ?? null,
  };
}

/** Newest first, undated last, then by path. */
function byDateThenPath(a: ListedPost, b: ListedPost): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Every Markdown file in content/blog on `main`, with its effective slug (frontmatter `slug`,
 * else the file name, `draft: true` files included) and the problem that keeps the editor off it.
 */
export async function postsOnMain(
  github: GitHub,
): Promise<{ treeSha: string; posts: ListedPost[] }> {
  const treeSha = await github.postsTree();
  if (treeSha === null) return { treeSha: "", posts: [] };
  if (cache?.treeSha === treeSha) return cache;
  const tree = await github.postsOnMain();
  if (!tree) return { treeSha: "", posts: [] };
  const posts = tree.entries
    .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
    .map(listedPost)
    .sort(byDateThenPath);
  cache = { treeSha: tree.oid, posts };
  return cache;
}

/** `GET /api/admin/posts`: the posts on `main`, each with the draft that tracks it. */
export async function listPosts(request: Request, env: PublishEnv): Promise<Response> {
  const github = createGitHub(env, request.url);
  const { treeSha, posts } = await postsOnMain(github);
  const { results } = await env.DB.prepare(
    "SELECT id, source_path, slug, status, pr_number, pr_action FROM drafts " +
      "WHERE source_path IN (SELECT value FROM json_each(?)) " +
      "OR slug IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(posts.map((p) => p.path)), JSON.stringify(posts.map((p) => p.slug)))
    .all<{
      id: string;
      source_path: string | null;
      slug: string | null;
      status: string;
      pr_number: number | null;
      pr_action: string | null;
    }>();
  const listed: PostOnMain[] = posts.map(({ post: _post, ...listedPost }) => {
    const row =
      results.find((draft) => draft.source_path === listedPost.path) ??
      results.find((draft) => draft.slug === listedPost.slug);
    return {
      ...listedPost,
      draft: row
        ? { id: row.id, status: row.status, prNumber: row.pr_number, prAction: row.pr_action }
        : null,
    };
  });
  return publishJson({ treeSha, posts: listed });
}

const postNotFound = () => publishError(404, "not_found", "No published post with that address.");
const unsupported = (problem: PostProblem) =>
  publishError(422, "unsupported_post", "The editor can't handle this file.", { problem });
const slugInUse = (draftId: string) =>
  publishError(409, "slug_in_use", "Another draft uses this address.", { draftId });

/** The draft holding `slug`, if any. */
function draftBySlug(db: D1Database, slug: string) {
  return db
    .prepare("SELECT id, kind FROM drafts WHERE slug = ?")
    .bind(slug)
    .first<{ id: string; kind: "new" | "edit" }>();
}

/**
 * Inserts an edit draft for a post on `main`, from the parsed file (or, for one that doesn't
 * parse, just its name). Returns its id, or null when another draft already holds the slug.
 */
export async function insertImportedDraft(
  db: D1Database,
  listed: ListedPost,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const { post } = listed;
  const inserted = await db
    .prepare(
      "INSERT INTO drafts (id, kind, source_path, base_sha, post_date, slug, title, summary, " +
        "category, tags, cover_key, body_md, rev, status, created_at, updated_at) " +
        "VALUES (?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?) " +
        "ON CONFLICT (slug) DO NOTHING RETURNING id",
    )
    .bind(
      id,
      listed.path,
      listed.sha,
      post?.date ?? null,
      listed.slug,
      post?.title ?? slugFromPath(listed.path),
      post?.summary ?? "",
      post?.category ?? null,
      JSON.stringify(post?.tags ?? []),
      post?.cover ?? null,
      post?.body ?? "",
      now,
      now,
    )
    .first<{ id: string }>();
  return inserted?.id ?? null;
}

/**
 * `POST /api/admin/posts/:slug/import`: `{}` opens the post's edit draft, creating it from `main`
 * if needed; `{refresh: true, baseRev}` loads the GitHub version into that draft.
 */
export async function importPost(
  request: Request,
  env: PublishEnv,
  slug: string,
): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const keys = Object.keys(body);
  if (keys.length === 0) return importDraft(request, env, slug);
  const { refresh, baseRev } = body;
  const known = keys.every((key) => key === "refresh" || key === "baseRev");
  if (!known || refresh !== true || !Number.isSafeInteger(baseRev) || (baseRev as number) < 1) {
    return publishError(400, "bad_request", "Send {} or {refresh: true, baseRev}.");
  }
  return refreshDraft(request, env, slug, baseRev as number);
}

async function importDraft(request: Request, env: PublishEnv, slug: string): Promise<Response> {
  const db = env.DB;
  const existing = await draftBySlug(db, slug);
  // The base SHA is checked when the draft is published, so reopening it needs no GitHub call.
  if (existing?.kind === "edit") return publishJson({ id: existing.id, created: false });

  const { posts } = await postsOnMain(createGitHub(env, request.url));
  const listed = posts.find((post) => post.slug === slug);
  if (!listed) return postNotFound();
  if (listed.problem) return unsupported(listed.problem);
  // A new post with this address: a first publish merged but not yet seen by a status poll.
  if (existing) return slugInUse(existing.id);

  const id = await insertImportedDraft(db, listed);
  if (id) return publishJson({ id, created: true }, 201);
  const raced = await draftBySlug(db, slug);
  if (raced?.kind === "edit") return publishJson({ id: raced.id, created: false });
  if (raced) return slugInUse(raced.id);
  throw new Error("an import lost its draft");
}

/**
 * Loads the GitHub version of the post into its draft, keeping the draft's version as a
 * `conflict` revision. A post that is gone from `main` turns the draft into a new post instead.
 * Either way the last pushed file (`pr_blob_sha`) is forgotten, so the new `base_sha` isn't
 * taken for GitHub merging a version other than the last one pushed.
 */
async function refreshDraft(
  request: Request,
  env: PublishEnv,
  slug: string,
  baseRev: number,
): Promise<Response> {
  const db = env.DB;
  const row = await db
    .prepare(
      "SELECT id, rev, status, merge_sha, source_path FROM drafts WHERE slug = ? AND kind = 'edit'",
    )
    .bind(slug)
    .first<{
      id: string;
      rev: number;
      status: string;
      merge_sha: string | null;
      source_path: string | null;
    }>();
  if (!row) return publishError(404, "not_found", "No draft edits a post with that address.");
  if (row.status === "publishing" && row.merge_sha === null) {
    return publishError(409, "publishing", "Cancel the open pull request first.");
  }

  const { posts } = await postsOnMain(createGitHub(env, request.url));
  // A renamed file is found by its slug.
  const listed =
    posts.find((post) => post.path === row.source_path) ?? posts.find((post) => post.slug === slug);
  const now = Date.now();
  const stale = async () => {
    const current = await db
      .prepare("SELECT rev FROM drafts WHERE id = ?")
      .bind(row.id)
      .first<{ rev: number }>();
    return publishError(409, "stale_draft", "This draft changed in another tab.", {
      rev: current?.rev ?? row.rev,
    });
  };

  if (!listed) {
    // Deleted on GitHub, or its merge reverted: publishing it again makes a new post.
    const converted = await db
      .prepare(
        "UPDATE drafts SET kind = 'new', source_path = NULL, base_sha = NULL, post_date = NULL, " +
          "pr_blob_sha = NULL, updated_at = ? WHERE id = ? AND rev = ? AND kind = 'edit' " +
          "AND (status != 'publishing' OR merge_sha IS NOT NULL) RETURNING rev",
      )
      .bind(now, row.id, baseRev)
      .first<{ rev: number }>();
    if (!converted) return stale();
    return publishJson({ id: row.id, created: false, converted: true, rev: converted.rev });
  }
  if (listed.problem || !listed.post) return unsupported(listed.problem ?? "invalid");

  const { post } = listed;
  const results = await db.batch<{ rev: number }>([
    snapshot(db, row.id, baseRev, "conflict", now),
    db
      .prepare(
        "UPDATE drafts SET title = ?, summary = ?, category = ?, tags = ?, cover_key = ?, " +
          "body_md = ?, base_sha = ?, source_path = ?, post_date = ?, pr_blob_sha = NULL, " +
          "rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? " +
          "AND (status != 'publishing' OR merge_sha IS NOT NULL) RETURNING rev",
      )
      .bind(
        post.title,
        post.summary,
        post.category ?? null,
        JSON.stringify(post.tags),
        post.cover ?? null,
        post.body,
        listed.sha,
        listed.path,
        post.date,
        now,
        row.id,
        baseRev,
      ),
  ]);
  const rev = results.at(-1)?.results[0]?.rev;
  if (rev === undefined) return stale();
  try {
    await db.batch(markImages(db, row.id, rev, now));
  } catch {
    // The refresh landed; the next save with a body marks again.
    console.error("Marking a draft's images after a refresh failed.");
  }
  return publishJson({ id: row.id, created: false, rev });
}
