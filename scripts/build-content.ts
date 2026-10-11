/**
 * Reads content/** and writes typed JSON to apps/web/app/generated/ (design doc §3.1).
 * Usage: tsx scripts/build-content.ts [--drafts]
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rehypeShiki from "@shikijs/rehype";
import { postFrontmatter, type Post } from "@site/content-schema";
import matter from "gray-matter";
import type { Root } from "hast";
import { toString } from "hast-util-to-string";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blogDir = path.join(root, "content/blog");
const outDir = path.join(root, "apps/web/app/generated");
const includeDrafts = process.argv.includes("--drafts");

const WORDS_PER_MINUTE = 220;

type Heading = Post["headings"][number];

/** Collects h2/h3 headings (after rehype-slug has added ids) for the table of contents. */
function collectHeadings(into: Heading[]) {
  return () => (tree: Root) => {
    visit(tree, "element", (node) => {
      const depth = { h2: 2, h3: 3 }[node.tagName];
      const id = node.properties.id;
      if (depth && typeof id === "string") into.push({ id, text: toString(node), depth });
    });
  };
}

async function renderMarkdown(markdown: string) {
  const headings: Heading[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    // Sanitize before highlighting so Shiki's inline styles survive.
    .use(rehypeSanitize, {
      ...defaultSchema,
      clobberPrefix: "",
      attributes: {
        ...defaultSchema.attributes,
        code: [["className", /^language-./]],
      },
    })
    .use(rehypeSlug)
    .use(collectHeadings(headings))
    .use(rehypeShiki, {
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), headings };
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

async function buildPosts(): Promise<Post[]> {
  const files = (await readdir(blogDir)).filter((name) => name.endsWith(".md")).sort();
  const errors: string[] = [];
  const posts: Post[] = [];

  for (const name of files) {
    const file = path.join(blogDir, name);
    const { data, content } = matter(await readFile(file, "utf8"));
    const parsed = postFrontmatter.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(
          `${path.relative(root, file)}: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
      }
      continue;
    }
    const meta = parsed.data;
    if (meta.draft && !includeDrafts) continue;

    const { html, headings } = await renderMarkdown(content);
    posts.push({
      slug: meta.slug ?? name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, ""),
      title: meta.title,
      summary: meta.summary,
      category: meta.category,
      date: isoDate(meta.date),
      updated: meta.updated && isoDate(meta.updated),
      tags: meta.tags,
      readingMinutes: Math.max(1, Math.round(content.split(/\s+/).length / WORDS_PER_MINUTE)),
      html,
      headings,
    });
  }

  const seen = new Set<string>();
  for (const post of posts) {
    if (seen.has(post.slug)) errors.push(`duplicate slug "${post.slug}"`);
    seen.add(post.slug);
  }

  if (errors.length > 0) {
    throw new Error(`Content errors:\n  ${errors.join("\n  ")}`);
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

try {
  const posts = await buildPosts();
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "posts.json"), JSON.stringify(posts));
  console.log(`build-content: ${posts.length} post(s)${includeDrafts ? " (drafts included)" : ""}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
