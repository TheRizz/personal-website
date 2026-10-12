import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import type { Root } from "hast";
import { toString } from "hast-util-to-string";
import rehypeSanitize, { defaultSchema, type Options as Schema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { BundledLanguage } from "shiki";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { remarkLeafDirective } from "./directive";
import { FIGURE_SIZES, figureToHast, remarkFigure, type Figure } from "./figure";

/** A Shiki highlighter: the full bundle in the build, a fine-grained one in the preview. */
export type Highlighter = Parameters<typeof rehypeShikiFromHighlighter>[0];

export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

/**
 * Languages the browser preview loads. The build highlights every bundled language; in the
 * preview, any other language shows as plain text.
 */
export const SHIKI_LANGS = [
  "bash",
  "css",
  "diff",
  "dockerfile",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "shellscript",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "yaml",
] as const satisfies readonly BundledLanguage[];

/**
 * GitHub's sanitize schema plus figures: `figure`, `figcaption`, the figure classes, and the
 * responsive `img` attributes. Raw HTML is still dropped.
 */
export const sanitizeSchema: Schema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./]],
    figure: [["className", "figure", ...FIGURE_SIZES.map((size) => `figure--${size}`)]],
    img: [...(defaultSchema.attributes?.img ?? []), "srcSet", "sizes", "loading", "decoding"],
  },
};

export interface Heading {
  id: string;
  text: string;
  depth: number;
}

export interface RenderedMarkdown {
  html: string;
  /** h2 and h3, for the table of contents. */
  headings: Heading[];
  figures: Figure[];
}

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

/** Rehype plugin: Shiki highlighting with the site's two themes, skipped without a highlighter. */
function rehypeHighlight(highlighter: Highlighter | null | undefined) {
  return highlighter
    ? rehypeShikiFromHighlighter(highlighter, { themes: SHIKI_THEMES, defaultColor: false })
    : undefined;
}

/**
 * Renders a post body to sanitized HTML. The one pipeline for the build and the editor preview,
 * so both show the same thing. Throws a `MarkdownError` for invalid image sections.
 */
export async function renderMarkdown(
  markdown: string,
  { highlighter }: { highlighter?: Highlighter | null } = {},
): Promise<RenderedMarkdown> {
  const headings: Heading[] = [];
  const figures: Figure[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkLeafDirective)
    .use(remarkFigure, { figures })
    .use(remarkRehype, { handlers: { leafDirective: figureToHast } })
    // Sanitize before highlighting so Shiki's inline styles survive.
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeSlug)
    .use(collectHeadings(headings))
    .use(rehypeHighlight, highlighter)
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), headings, figures };
}
