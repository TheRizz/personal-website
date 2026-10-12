import { postFrontmatter } from "@site/content-schema";
import type { DraftFields } from "./drafts";

// The content/blog/YYYY-MM-DD-slug.md file for a draft (design doc §4.9.3, "Download .md").
// Until publishing from the editor ships, this file, committed through a normal PR, is how a
// draft goes live. Every value is written with JSON.stringify, which is valid YAML and can't be
// read back as another type (a tag named `true` stays a string).

const tagSchema = postFrontmatter.pick({ tags: true });

/** A tag as the post schema stores it (lowercase kebab-case), or null if nothing is left. */
export function normalizeTag(tag: string): string | null {
  const result = tagSchema.safeParse({ tags: [tag] });
  return result.success ? (result.data.tags[0] ?? null) : null;
}

/** Normalises and de-duplicates tags, dropping any that end up empty. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter((tag): tag is string => tag !== null))];
}

/** A URL slug from a title: lowercase kebab-case, at most 80 characters. */
export function slugify(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80)
      .replace(/-$/, "") || "post"
  );
}

/** Today's date in the owner's time zone, as YYYY-MM-DD. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export type PostFile =
  { ok: true; filename: string; path: string; content: string } | { ok: false; errors: string[] };

/**
 * The Markdown file for `draft`, dated `date`, or why it can't be written yet. The frontmatter is
 * checked against the same schema the build uses, so a file this returns builds.
 */
export function postFile(
  draft: DraftFields & { slug?: string | null; cover?: string | null },
  date: string,
): PostFile {
  const meta: Record<string, unknown> = {
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    date,
    ...(draft.category?.trim() && { category: draft.category.trim() }),
    tags: normalizeTags(draft.tags),
    ...(draft.cover && { cover: draft.cover }),
  };
  const check = postFrontmatter.safeParse(meta);
  const errors: string[] = [];
  if (!meta.title) errors.push("Add a title.");
  if (!meta.summary) errors.push("Add a summary.");
  if (!check.success && errors.length === 0) {
    errors.push(...check.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  if (!draft.bodyMd.trim()) errors.push("Write something in the body.");
  if (errors.length > 0) return { ok: false, errors };

  const slug = draft.slug ?? slugify(draft.title);
  const lines = Object.entries(meta).map(([key, value]) =>
    key === "date" ? `${key}: ${value as string}` : `${key}: ${JSON.stringify(value)}`,
  );
  const body = draft.bodyMd.replace(/\s+$/, "");
  const filename = `${date}-${slug}.md`;
  return {
    ok: true,
    filename,
    path: `content/blog/${filename}`,
    content: `---\n${lines.join("\n")}\n---\n\n${body}\n`,
  };
}
