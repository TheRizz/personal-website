import { postFrontmatter } from "@site/content-schema";
// The package is CommonJS and its index re-exports through a variable, which Node can't map to
// named exports, so it is imported whole.
import yaml from "js-yaml";
import { normalizeTags } from "../admin/post-file";

// Reads a post file the way the build does (gray-matter 4.0.3 with js-yaml 3, then the post
// schema), for the Worker's publishing code: import from `main`, "What changed", and the check
// that a publish changes anything. The editor never imports this; it only writes files.

/** A post as its file states it, normalised the way `postFile` writes it. */
export interface PostSnapshot {
  title: string;
  summary: string;
  /** YYYY-MM-DD. */
  date: string;
  updated?: string;
  category?: string;
  tags: string[];
  cover?: string;
  /** The Markdown body, without leading newlines or trailing whitespace. */
  body: string;
}

export type ParsedPost =
  | {
      ok: true;
      post: PostSnapshot;
      /** gray-matter's `content`, for `readingMinutes`. */
      content: string;
      frontmatterSlug?: string;
      draft: boolean;
    }
  | { ok: false; errors: string[] };

/**
 * Splits a file into its frontmatter and the rest exactly as gray-matter 4.0.3 does, or returns
 * null when it has none. `language` is whatever follows the opening `---` (gray-matter would pick
 * another parser for it, and `js` would run the frontmatter as code).
 */
export function splitFrontmatter(
  text: string,
): { matter: string; content: string; language: string } | null {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!source.startsWith("---") || source.charAt(3) === "-") return null;
  let rest = source.slice(3);
  const length = rest.length;
  // As gray-matter: without a line break this drops the last character, which can't matter here.
  const raw = rest.slice(0, rest.search(/\r?\n/));
  const language = raw.trim();
  if (language) rest = rest.slice(raw.length);
  let close = rest.indexOf("\n---");
  if (close === -1) close = length;
  const matter = rest.slice(0, close);
  if (close === length) return { matter, content: "", language };
  let content = rest.slice(close + 4);
  if (content.startsWith("\r")) content = content.slice(1);
  if (content.startsWith("\n")) content = content.slice(1);
  return { matter, content, language };
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** Where js-yaml stopped, without echoing any of the file. */
function yamlError(error: unknown): string {
  const line = (error as { mark?: { line?: unknown } } | null)?.mark?.line;
  return typeof line === "number"
    ? `the frontmatter isn't valid YAML (line ${line + 1})`
    : "the frontmatter isn't valid YAML";
}

interface SnapshotInput {
  title: string;
  summary: string;
  date: string;
  updated?: string;
  category?: string | null;
  tags: string[];
  cover?: string | null;
  body: string;
}

/** The fields exactly as `postFile` would write them, so equal posts compare equal. */
function normalise(input: SnapshotInput): PostSnapshot {
  const category = input.category?.trim();
  return {
    title: input.title.trim(),
    summary: input.summary.trim(),
    date: input.date,
    ...(input.updated !== undefined && { updated: input.updated }),
    ...(category && { category }),
    tags: normalizeTags(input.tags),
    ...(input.cover && { cover: input.cover }),
    body: input.body.replace(/^\n+/, "").replace(/\s+$/, ""),
  };
}

/** Parses a post file as the build would, or lists why the build would refuse it. */
export function parsePostFile(text: string): ParsedPost {
  const split = splitFrontmatter(text);
  if (!split) return { ok: false, errors: ["the file has no frontmatter"] };
  if (split.language) return { ok: false, errors: ["unsupported frontmatter language"] };

  // gray-matter skips the YAML parser for a block of only comments and whitespace.
  let data: unknown = {};
  if (split.matter.replace(/^\s*#[^\n]+/gm, "").trim() !== "") {
    try {
      data = yaml.safeLoad(split.matter);
    } catch (error) {
      return { ok: false, errors: [yamlError(error)] };
    }
  }
  const parsed = postFrontmatter.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const meta = parsed.data;
  return {
    ok: true,
    post: normalise({
      ...meta,
      date: isoDate(meta.date),
      updated: meta.updated && isoDate(meta.updated),
      body: split.content,
    }),
    content: split.content,
    ...(meta.slug !== undefined && { frontmatterSlug: meta.slug }),
    draft: meta.draft,
  };
}

/** The post a draft would publish, dated `date` (and `updated`), to compare with a parsed file. */
export function snapshotOf(
  draft: {
    title: string;
    summary: string;
    category: string | null;
    tags: string[];
    bodyMd: string;
    cover?: string | null;
  },
  date: string,
  updated?: string,
): PostSnapshot {
  return normalise({ ...draft, body: draft.bodyMd, date, updated });
}

/** Whether two snapshots are the same post. `updated` is ignored: it changes with every publish. */
export function samePost(a: PostSnapshot, b: PostSnapshot): boolean {
  return (
    a.title === b.title &&
    a.summary === b.summary &&
    a.date === b.date &&
    a.category === b.category &&
    a.cover === b.cover &&
    a.body === b.body &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}
