import { z } from "zod";

// Zod's optional JIT probes `new Function`, which the site's CSP blocks and reports as a
// violation (the admin editor uses this schema in the browser). Parsing works the same without it.
z.config({ jitless: true });

/** Lowercase kebab-case, e.g. "durable-objects". */
const tag = z
  .string()
  .trim()
  .transform((value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  )
  .pipe(z.string().min(1, "tag is empty after normalising"));

/** Frontmatter of a blog post in content/blog/*.md (design doc §4.2). */
export const postFrontmatter = z.strictObject({
  title: z.string().min(1),
  summary: z.string().min(1).max(300),
  date: z.coerce.date(),
  updated: z.coerce.date().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
    .optional(),
  /** Checked against content/taxonomy.yaml once that file exists (Phase 3). */
  category: z.string().min(1).optional(),
  tags: z.array(tag).default([]),
  /** R2 key of a cover image. */
  cover: z.string().min(1).optional(),
  draft: z.boolean().default(false),
});

export type PostFrontmatter = z.infer<typeof postFrontmatter>;

/** A post as emitted by scripts/build-content.ts into posts.json. */
export interface Post {
  slug: string;
  title: string;
  summary: string;
  category?: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  updated?: string;
  tags: string[];
  readingMinutes: number;
  html: string;
  headings: { id: string; text: string; depth: number }[];
}

/** What list pages need: a post without its rendered body. */
export type PostSummary = Omit<Post, "html" | "headings">;
