import type { Element, ElementContent } from "hast";
import type { Root } from "mdast";
import type { LeafDirective } from "mdast-util-directive";
import type { State } from "mdast-util-to-hast";
import { visit } from "unist-util-visit";

declare module "mdast-util-directive" {
  interface LeafDirectiveData {
    /** Set by `remarkFigure` once the directive's attributes are valid. */
    figure?: Figure;
  }
}

/** Public origin of the R2 `photos` bucket. */
export const PHOTOS_ORIGIN = "https://photos.ry-mart.com";

/** A figure `src` is a logical R2 key, never a URL (design doc §4.9.4). */
export const FIGURE_SRC = /^blog\/[0-9a-f-]{36}\.(webp|jpg|png|gif)$/;

export const FIGURE_SIZES = ["column", "wide", "full"] as const;

export type FigureSize = (typeof FIGURE_SIZES)[number];

/** Uploads are scaled down to this width first, so `w` is never larger. */
export const MAX_FIGURE_WIDTH = 2048;

/** Smaller variants stored for every image wider than them. */
const VARIANT_WIDTHS = [480, 1024];

/** `<img src>` for browsers without `srcset`: the largest variant up to this width. */
const FALLBACK_WIDTH = 1024;

/** Rendered width of each size class, matching the figure CSS in apps/web/app/app.css. */
const SIZES: Record<FigureSize, string> = {
  column: "(min-width: 53.25rem) 50.25rem, calc(100vw - 3rem)",
  wide: "(min-width: 68.75rem) 68.75rem, 100vw",
  full: "100vw",
};

const ATTRIBUTES = new Set(["src", "alt", "size", "w", "h"]);

/** A validated image section: `::figure[caption]{src alt size w h}`. */
export interface Figure {
  src: string;
  alt: string;
  size: FigureSize;
  /** Width and height of the largest stored variant. */
  w: number;
  h: number;
}

/** A problem in a Markdown body, with its 1-based line and column in that body. */
export interface MarkdownIssue {
  line: number;
  column: number;
  message: string;
}

/** Thrown by `renderMarkdown` when the body has invalid image sections. */
export class MarkdownError extends Error {
  constructor(readonly issues: MarkdownIssue[]) {
    super(issues.map((issue) => `line ${issue.line}: ${issue.message}`).join("\n"));
    this.name = "MarkdownError";
  }
}

/** The widths stored for an image: each of 480 and 1024 narrower than `w`, plus `w` itself. */
export function figureWidths(src: string, w: number): number[] {
  if (src.endsWith(".gif")) return [w];
  return [...VARIANT_WIDTHS.filter((width) => width < w), w];
}

/** R2 key of one variant, `blog/<uuid>-<width>.<ext>`; a GIF is stored once, under `src`. */
export function variantKey(src: string, width: number): string {
  if (src.endsWith(".gif")) return src;
  return src.replace(/\.(\w+)$/, `-${width}.$1`);
}

/** Public URLs of every stored variant of a figure. */
export function figureUrls(figure: Figure): string[] {
  return figureWidths(figure.src, figure.w).map(
    (width) => `${PHOTOS_ORIGIN}/${variantKey(figure.src, width)}`,
  );
}

const isSize = (value: string): value is FigureSize =>
  (FIGURE_SIZES as readonly string[]).includes(value);

const dimension = (value: string | null | undefined) =>
  value && /^[1-9]\d{0,4}$/.test(value) ? Number(value) : undefined;

/** Validates a leaf directive as a figure; returns the figure, or every problem with it. */
export function parseFigure(
  name: string,
  attributes: Record<string, string | null | undefined> = {},
): { figure: Figure; errors?: undefined } | { figure?: undefined; errors: string[] } {
  if (name !== "figure") {
    return { errors: [`unknown directive "::${name}" (write "\\::" for literal colons)`] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(attributes)) {
    if (!ATTRIBUTES.has(key)) errors.push(`::figure has an unknown attribute "${key}"`);
  }
  const { src, alt, size = "column", w, h } = attributes;
  if (!src || !FIGURE_SRC.test(src)) {
    errors.push(`::figure src must be an image key like "blog/<uuid>.webp", got "${src ?? ""}"`);
  }
  if (!alt?.trim()) errors.push("::figure needs a non-empty alt");
  if (!size || !isSize(size)) {
    errors.push(`::figure size must be ${FIGURE_SIZES.join(", ")}, got "${size ?? ""}"`);
  }
  const width = dimension(w);
  const height = dimension(h);
  if (width === undefined || height === undefined) {
    errors.push("::figure needs w and h, the largest variant's size in pixels");
  } else if (width > MAX_FIGURE_WIDTH) {
    errors.push(`::figure w must be at most ${MAX_FIGURE_WIDTH}`);
  }
  // The checks above already failed for any of these; repeated so TypeScript narrows them.
  if (errors.length > 0 || !src || !alt || !size || !isSize(size) || !width || !height) {
    return { errors };
  }
  return { figure: { src, alt, size, w: width, h: height } };
}

/**
 * Remark plugin: validates every leaf directive as a figure and pushes valid ones to `figures`.
 * Throws a `MarkdownError` listing every bad one, so a build fails with lines to fix.
 */
export function remarkFigure({ figures = [] }: { figures?: Figure[] } = {}) {
  return (tree: Root) => {
    const issues: MarkdownIssue[] = [];
    visit(tree, "leafDirective", (node) => {
      const result = parseFigure(node.name, node.attributes ?? {});
      if (result.figure) {
        (node.data ??= {}).figure = result.figure;
        figures.push(result.figure);
        return;
      }
      const { line = 0, column = 0 } = node.position?.start ?? {};
      for (const message of result.errors) issues.push({ line, column, message });
    });
    if (issues.length > 0) throw new MarkdownError(issues);
  };
}

/** The `<img>` of a figure: `srcset` over the stored variants, and `sizes` from its size class. */
function figureImage({ src, alt, size, w, h }: Figure): Element {
  const widths = figureWidths(src, w);
  const url = (width: number) => `${PHOTOS_ORIGIN}/${variantKey(src, width)}`;
  const fallback = widths.filter((width) => width <= FALLBACK_WIDTH).at(-1) ?? w;
  return {
    type: "element",
    tagName: "img",
    properties: {
      src: url(fallback),
      ...(widths.length > 1 && {
        srcSet: widths.map((width) => `${url(width)} ${width}w`).join(", "),
        sizes: SIZES[size],
      }),
      width: w,
      height: h,
      alt,
      loading: "lazy",
      decoding: "async",
    },
    children: [],
  };
}

/** mdast-util-to-hast handler: a validated figure directive becomes `figure > img + figcaption`. */
export function figureToHast(state: State, node: LeafDirective): Element | undefined {
  const figure = node.data?.figure;
  if (!figure) return undefined;
  const children: ElementContent[] = [figureImage(figure)];
  if (node.children.length > 0) {
    children.push({
      type: "element",
      tagName: "figcaption",
      properties: {},
      children: state.all(node),
    });
  }
  const result: Element = {
    type: "element",
    tagName: "figure",
    properties: { className: ["figure", `figure--${figure.size}`] },
    children: state.wrap(children, true),
  };
  state.patch(node, result);
  return result;
}
