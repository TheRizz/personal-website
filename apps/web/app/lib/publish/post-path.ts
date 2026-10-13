import { site } from "../../site";

// Names and addresses shared by the editor and the Worker's publishing code (design doc §4.9.7):
// where a post lives in the repo, its branch and its public URL. Pure, so both sides import it.

/** The site's public origin; `site.url` is the only place it is written. */
export const SITE_ORIGIN = site.url;
/** The public repository posts are published to. */
export const REPO_URL = "https://github.com/TheRizz/personal-website";

/** A URL slug: lowercase kebab-case. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest slug; `slugify()` cuts titles to this length. */
export const MAX_SLUG_LENGTH = 80;
/** A post file in the repo, `content/blog/YYYY-MM-DD-<slug>.md`. */
export const POST_PATH = /^content\/blog\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** A publishing branch, `blog/<slug>-<unix seconds>`. */
export const BRANCH = /^blog\/[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/;
/** A full git object id. */
export const GIT_SHA = /^[0-9a-f]{40}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-/;

/** Whether `value` is a slug of at most 80 characters. */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG.test(value);
}

/** Whether `value` is a real calendar date written as YYYY-MM-DD (so 2026-02-30 isn't). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Whether `path` is a post file the editor may write. */
export function isPostPath(path: string): boolean {
  return POST_PATH.test(path);
}

/** Whether `value` is a publishing branch name. */
export function isBranch(value: string): boolean {
  return BRANCH.test(value);
}

/** Whether `value` is a full, lowercase git SHA. */
export function isGitSha(value: unknown): value is string {
  return typeof value === "string" && GIT_SHA.test(value);
}

/** The repo path of the post `slug` dated `date`. Throws if either is invalid. */
export function postPath(date: string, slug: string): string {
  if (!isIsoDate(date) || !isSlug(slug)) throw new Error("invalid post path");
  return `content/blog/${date}-${slug}.md`;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The slug a post file gets from its name, as the build derives it. */
export function slugFromPath(path: string): string {
  return basename(path)
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/\.md$/, "");
}

/** The YYYY-MM-DD the post file's name starts with. Throws if it has none. */
export function dateFromPath(path: string): string {
  const match = DATE_PREFIX.exec(basename(path));
  if (!match?.[1]) throw new Error("the post file name has no date");
  return match[1];
}

/** The branch a PR for `slug` opened at `unixSeconds` uses. Throws on invalid input. */
export function branchName(slug: string, unixSeconds: number): string {
  if (!isSlug(slug) || !Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    throw new Error("invalid branch name");
  }
  return `blog/${slug}-${unixSeconds}`;
}

/** Whether `branch` is exactly `blog/<slug>-<digits>`, so `blog/a-b-1` isn't one for `a`. */
export function isBranchForSlug(branch: string, slug: string): boolean {
  const prefix = `blog/${slug}-`;
  return isSlug(slug) && branch.startsWith(prefix) && /^\d+$/.test(branch.slice(prefix.length));
}

/** The public URL of the post `slug`. */
export function postUrl(slug: string): string {
  return `${SITE_ORIGIN}/blog/${slug}`;
}

/** The GitHub page of pull request `n`. */
export function pullUrl(n: number): string {
  return `${REPO_URL}/pull/${n}`;
}

const REPO_PATH = new URL(REPO_URL).pathname + "/";

/**
 * `url` if it is a page of this repository on github.com (a workflow run, a check), else null.
 * Run links come from GitHub's answers and are shown as links, so anything else is dropped.
 */
export function safeRunUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ok =
    parsed.origin === "https://github.com" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname.startsWith(REPO_PATH);
  return ok ? parsed.href : null;
}
