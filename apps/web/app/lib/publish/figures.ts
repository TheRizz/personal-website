import {
  PHOTOS_ORIGIN,
  figureWidths,
  parseFigure,
  variantKey,
  type Figure,
} from "@site/content-markdown/figure";

// The `::figure` lines of a post body, found with a line scan instead of the Markdown parser so
// the Worker can check them without remark or Shiki (only figure.ts is imported from
// content-markdown). It follows the leaf directive syntax of micromark-extension-directive, and is
// stricter in one way: a line that starts with "::" but isn't a whole directive is an error here,
// where the build would print it as text. The editor writes "\::" for colons typed at the start of
// a line, so such a line can only be a typo in raw mode.

/** A valid figure, with its Markdown caption and its 1-based line in the body. */
export interface LintedFigure extends Figure {
  caption: string;
  line: number;
}

const WHOLE_DIRECTIVE =
  'a line starting with "::" must be a whole ::figure[caption]{…}; write "\\::" for literal colons';

/** Block quote and list markers before a line's content: `> `, `- `, `* `, `+ `, `1. `, `1) `. */
const CONTAINER = /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*/;
/** A leaf directive's start: two colons, not three (`:::` isn't part of the format), a letter. */
const CANDIDATE = /^::(?!:)[A-Za-z]/;
const NAME = /^[A-Za-z][A-Za-z0-9_-]*/;
const ATTRIBUTE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*/;
/** Characters that end (or, where the syntax says so, spoil) an unquoted value. */
const UNQUOTED_VALUE = /^[^ \t"'<=>`}]+/;
const SHORTCUT_VALUE = /^[^ \t"'#.<=>`}]+/;
/** micromark-extension-directive refuses deeper nesting of brackets in a label. */
const MAX_LABEL_DEPTH = 32;
/** figure.ts uses this variant as the rendered `<img src>`. */
const FALLBACK_WIDTH = 1024;

interface Fence {
  marker: string;
  length: number;
}

/** The fence a line opens, if any. A backtick fence's info string can't hold a backtick. */
function openingFence(line: string): Fence | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match?.[1]) return null;
  const sequence = match[1];
  if (sequence.startsWith("`") && match[2]?.includes("`")) return null;
  return { marker: sequence.charAt(0), length: sequence.length };
}

/** Whether a line closes `fence`: the same character, at least as many, then only spaces. */
function closesFence(line: string, fence: Fence): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!match?.[1] && match[1].startsWith(fence.marker) && match[1].length >= fence.length;
}

const NAMED_REFERENCES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: "\u00A0",
};

/** Decodes numeric character references and a few named ones; other names stay as written. */
function decodeReferences(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|(quot|amp|lt|gt|apos|nbsp));/g,
    (_match, decimal?: string, hex?: string, name?: string) => {
      if (name) return NAMED_REFERENCES[name] ?? "";
      const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : "\uFFFD";
    },
  );
}

/** Index of the `]` that closes the label opened at `start`, or -1. */
function labelEnd(line: string, start: number): number {
  let depth = 0;
  for (let index = start + 1; index < line.length; index++) {
    const char = line[index];
    if (char === "\\" && /[[\\\]]/.test(line[index + 1] ?? "")) {
      index++;
    } else if (char === "[") {
      if (++depth > MAX_LABEL_DEPTH) return -1;
    } else if (char === "]") {
      if (depth === 0) return index;
      depth--;
    }
  }
  return -1;
}

const isSpace = (char: string | undefined) => char === " " || char === "\t";

/**
 * The `{…}` attributes opened at `start`: `key="v"`, `key='v'`, `key=v`, `key`, `#id`, `.class`.
 * Returns where they end, or null if they don't close properly.
 */
function parseAttributes(
  line: string,
  start: number,
): { attributes: Record<string, string>; end: number } | null {
  const list: [string, string][] = [];
  let index = start + 1;
  const skipSpace = () => {
    while (isSpace(line[index])) index++;
  };
  for (;;) {
    skipSpace();
    const char = line[index];
    if (char === "}") {
      // As mdast-util-directive: a later key wins, and classes add up.
      const attributes = new Map<string, string>();
      for (const [key, value] of list) {
        const classes = key === "class" ? attributes.get("class") : undefined;
        attributes.set(key, classes ? `${classes} ${value}` : value);
      }
      return { attributes: Object.fromEntries(attributes), end: index + 1 };
    }
    if (char === "#" || char === ".") {
      const value = SHORTCUT_VALUE.exec(line.slice(index + 1))?.[0];
      if (!value) return null;
      index += 1 + value.length;
      const next = line[index];
      if (!(next === "#" || next === "." || next === "}" || isSpace(next))) return null;
      list.push([char === "#" ? "id" : "class", decodeReferences(value)]);
      continue;
    }
    const name = ATTRIBUTE_NAME.exec(line.slice(index))?.[0];
    if (!name) return null;
    index += name.length;
    skipSpace();
    if (line[index] !== "=") {
      list.push([name, ""]);
      continue;
    }
    index++;
    skipSpace();
    const quote = line[index];
    if (quote === '"' || quote === "'") {
      const close = line.indexOf(quote, index + 1);
      if (close === -1) return null;
      list.push([name, decodeReferences(line.slice(index + 1, close))]);
      index = close + 1;
      const next = line[index];
      if (!(next === "}" || isSpace(next))) return null;
    } else {
      const value = UNQUOTED_VALUE.exec(line.slice(index))?.[0];
      if (!value) return null;
      index += value.length;
      const next = line[index];
      if (!(next === "}" || isSpace(next))) return null;
      list.push([name, decodeReferences(value)]);
    }
  }
}

/** A whole leaf directive (`::name[label]{attributes}` and nothing else), or null. */
function parseLeafDirective(
  line: string,
): { name: string; label: string; attributes: Record<string, string> } | null {
  const name = NAME.exec(line.slice(2))?.[0];
  if (!name) return null;
  let index = 2 + name.length;
  let label = "";
  if (line[index] === "[") {
    const end = labelEnd(line, index);
    if (end === -1) return null;
    label = line.slice(index + 1, end);
    index = end + 1;
  }
  let attributes: Record<string, string> = {};
  if (line[index] === "{") {
    const parsed = parseAttributes(line, index);
    if (!parsed) return null;
    attributes = parsed.attributes;
    index = parsed.end;
  }
  return /^[ \t]*$/.test(line.slice(index)) ? { name, label, attributes } : null;
}

/**
 * Every figure in a post body, and every problem with its `::` lines, in the build's terms.
 * Lines in block quotes and list items count; lines in fenced code don't.
 */
export function lintFigures(body: string): {
  figures: LintedFigure[];
  errors: { line: number; message: string }[];
} {
  const figures: LintedFigure[] = [];
  const errors: { line: number; message: string }[] = [];
  let fence: Fence | null = null;
  body.split(/\r\n|\r|\n/).forEach((text, index) => {
    const line = text.replace(CONTAINER, "");
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      return;
    }
    fence = openingFence(line);
    if (fence || !CANDIDATE.test(line)) return;
    const number = index + 1;
    const directive = parseLeafDirective(line);
    if (!directive) {
      errors.push({ line: number, message: WHOLE_DIRECTIVE });
      return;
    }
    const result = parseFigure(directive.name, directive.attributes);
    if (result.figure) {
      figures.push({ ...result.figure, caption: directive.label, line: number });
    } else {
      for (const message of result.errors) errors.push({ line: number, message });
    }
  });
  return { figures, errors };
}

/** The image keys of a body's valid figures, once each, in order. */
export function figureSrcsOf(body: string): string[] {
  return [...new Set(lintFigures(body).figures.map((figure) => figure.src))];
}

/**
 * Every image key that appears anywhere in `text`, once each. Deliberately loose (code blocks,
 * links, prose all count), like the client's `figureSrcs`: marking an extra image published only
 * keeps it, while missing one could let the clean-up delete an image a post uses.
 */
export function mentionedFigureSrcs(text: string): string[] {
  return [...new Set(text.match(/blog\/[0-9a-f-]{36}\.(?:webp|jpg|png|gif)/g) ?? [])];
}

/** The image URL the rendered post uses as `<img src>`: the largest variant up to 1024 wide. */
export function figurePreviewUrl(figure: Pick<Figure, "src" | "w">): string {
  const widths = figureWidths(figure.src, figure.w);
  const fallback = widths.filter((width) => width <= FALLBACK_WIDTH).at(-1) ?? figure.w;
  return `${PHOTOS_ORIGIN}/${variantKey(figure.src, fallback)}`;
}
