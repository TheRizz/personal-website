/**
 * Reads content/** and writes typed JSON to apps/web/app/generated/ (design doc §3.1).
 * Usage: tsx scripts/build-content.ts [--drafts] [--check-images] [--content <dir>] [--out <dir>]
 *
 * `--check-images` also requests every figure image from photos.ry-mart.com and fails if one is
 * missing. CI runs it only when content/blog changes, so other PRs never depend on that host.
 *
 * `--content` and `--out` replace `content/` and `apps/web/app/generated/`, so a test can build
 * a fixture tree into a temporary directory. Everything the build writes goes in the out
 * directory: the draft privacy test (apps/web/worker/draft-privacy.test.ts) reads all of it.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  MarkdownError,
  SHIKI_THEMES,
  figureUrls,
  renderMarkdown,
  type Figure,
} from "@site/content-markdown";
import { postFrontmatter, readingMinutes, type Post } from "@site/content-schema";
import matter from "gray-matter";
import { bundledLanguages, createHighlighter } from "shiki";

const { values: args } = parseArgs({
  // pnpm hands a `--` on to the script, as in `pnpm content -- --drafts`.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    drafts: { type: "boolean", default: false },
    "check-images": { type: "boolean", default: false },
    content: { type: "string" },
    out: { type: "string" },
  },
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = args.content ? path.resolve(args.content) : path.join(root, "content");
const blogDir = path.join(contentDir, "blog");
const outDir = args.out ? path.resolve(args.out) : path.join(root, "apps/web/app/generated");
const includeDrafts = args.drafts;
const checkImages = args["check-images"];

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** A built post, its source file and the figures in its body. */
interface Built {
  file: string;
  post: Post;
  figures: Figure[];
}

async function buildPosts(): Promise<Built[]> {
  const files = (await readdir(blogDir)).filter((name) => name.endsWith(".md")).sort();
  const errors: string[] = [];
  const built: Built[] = [];
  // Every bundled language, as @shikijs/rehype loads by default; unknown ones stay plain text.
  const highlighter = await createHighlighter({
    themes: Object.values(SHIKI_THEMES),
    langs: Object.keys(bundledLanguages),
  });

  for (const name of files) {
    // Named from the content directory's parent, `content/blog/x.md`, for a fixture tree too.
    const file = path.relative(path.dirname(contentDir), path.join(blogDir, name));
    const source = await readFile(path.join(blogDir, name), "utf8");
    const { data, content } = matter(source);
    const parsed = postFrontmatter.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }
    const meta = parsed.data;
    if (meta.draft && !includeDrafts) continue;

    let rendered;
    try {
      rendered = await renderMarkdown(content, { highlighter });
    } catch (error) {
      if (!(error instanceof MarkdownError)) throw error;
      // Issue lines count from the start of the body; add the frontmatter's lines.
      const offset = source.slice(0, source.length - content.length).split("\n").length - 1;
      for (const issue of error.issues) {
        errors.push(`${file}:${issue.line + offset}: ${issue.message}`);
      }
      continue;
    }
    const { html, headings, figures } = rendered;
    const post: Post = {
      slug: meta.slug ?? name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, ""),
      title: meta.title,
      summary: meta.summary,
      category: meta.category,
      date: isoDate(meta.date),
      updated: meta.updated && isoDate(meta.updated),
      tags: meta.tags,
      readingMinutes: readingMinutes(content),
      html,
      headings,
    };
    built.push({ file, post, figures });
  }

  const seen = new Set<string>();
  for (const { post } of built) {
    if (seen.has(post.slug)) errors.push(`duplicate slug "${post.slug}"`);
    seen.add(post.slug);
  }

  if (errors.length > 0) {
    throw new Error(`Content errors:\n  ${errors.join("\n  ")}`);
  }
  return built.sort((a, b) => b.post.date.localeCompare(a.post.date));
}

/** Requests every stored variant of every figure; throws listing any that isn't an image. */
async function checkFigureImages(built: Built[]) {
  const checks = built.flatMap(({ file, figures }) =>
    figures.flatMap(figureUrls).map(async (url) => {
      try {
        const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
        const type = response.headers.get("content-type") ?? "";
        if (response.ok && type.startsWith("image/")) return [];
        return [`${file}: ${url} returned ${response.status} ${type}`.trimEnd()];
      } catch (error) {
        // fetch() hides the network error (DNS, TLS, timeout) in `cause`.
        const reason = error instanceof Error ? (error.cause ?? error) : error;
        return [`${file}: ${url} failed: ${reason instanceof Error ? reason.message : reason}`];
      }
    }),
  );
  const problems = (await Promise.all(checks)).flat();
  if (problems.length > 0) throw new Error(`Missing images:\n  ${problems.join("\n  ")}`);
  console.log(`build-content: ${checks.length} figure image(s) found`);
}

try {
  const built = await buildPosts();
  if (checkImages) await checkFigureImages(built);
  const posts = built.map(({ post }) => post);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "posts.json"), JSON.stringify(posts));
  console.log(`build-content: ${posts.length} post(s)${includeDrafts ? " (drafts included)" : ""}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
