import type {
  BlockContent,
  Definition,
  List,
  ListItem,
  Nodes,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import type { LeafDirective } from "mdast-util-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify, { type Options as StringifyOptions } from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { remarkLeafDirective } from "./directive";
import { MarkdownError, parseFigure } from "./figure";

/** A mark in TipTap's JSON: `bold`, `italic`, `code` or `link` (`attrs.href`, `attrs.title`). */
export interface DocMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * A node in TipTap's JSON (what `editor.getJSON()` returns). The bridge reads and writes the
 * StarterKit nodes plus `figure` (`attrs: {src, alt, size, w, h}`, caption as inline content).
 * Lists carry `attrs.tight`, which the editor's list extensions must keep.
 */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

/** How published posts are written: `-` bullets and rules, `*` emphasis, backtick fences. */
const STRINGIFY: StringifyOptions = {
  bullet: "-",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  listItemIndent: "one",
};

/** Outermost first when marks start and end together; `***a***` is `<em><strong>`. */
const MARK_ORDER = ["link", "italic", "bold"];

const unsupported = (node: Nodes, what: string) =>
  new MarkdownError([
    {
      line: node.position?.start.line ?? 0,
      column: node.position?.start.column ?? 0,
      message: `${what} isn't supported by the editor; edit it in the Raw Markdown tab`,
    },
  ]);

const withMarks = (node: DocNode, marks: DocMark[]): DocNode =>
  marks.length > 0 ? { ...node, marks } : node;

const sameMarks = (a: DocMark[] = [], b: DocMark[] = []) =>
  a.length === b.length && a.every((mark, i) => sameMark(mark, b[i]));

function sameMark(a: DocMark, b: DocMark | undefined): boolean {
  return (
    a.type === b?.type &&
    (a.attrs?.href ?? null) === (b.attrs?.href ?? null) &&
    (a.attrs?.title ?? null) === (b.attrs?.title ?? null)
  );
}

/** Joins neighbouring text nodes with the same marks, as ProseMirror does. */
function mergeText(nodes: DocNode[]): DocNode[] {
  const merged: DocNode[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (last?.type === "text" && node.type === "text" && sameMarks(last.marks, node.marks)) {
      merged[merged.length - 1] = { ...last, text: `${last.text ?? ""}${node.text ?? ""}` };
    } else if (node.type !== "text" || node.text) {
      merged.push(node);
    }
  }
  return merged;
}

function inlineToDoc(
  nodes: PhrasingContent[],
  marks: DocMark[],
  definitions: Map<string, Definition>,
): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    switch (node.type) {
      case "text":
        return [withMarks({ type: "text", text: node.value }, marks)];
      case "inlineCode":
        return [withMarks({ type: "text", text: node.value }, [...marks, { type: "code" }])];
      case "emphasis":
        return inlineToDoc(node.children, [...marks, { type: "italic" }], definitions);
      case "strong":
        return inlineToDoc(node.children, [...marks, { type: "bold" }], definitions);
      case "break":
        return [{ type: "hardBreak" }];
      case "link":
      case "linkReference": {
        const target = node.type === "link" ? node : definitions.get(node.identifier);
        if (!target) throw unsupported(node, "A link without a definition");
        const link = { type: "link", attrs: { href: target.url, title: target.title ?? null } };
        return inlineToDoc(node.children, [...marks, link], definitions);
      }
      default:
        throw unsupported(node, `Markdown "${node.type}"`);
    }
  });
}

function blockToDoc(node: RootContent, definitions: Map<string, Definition>): DocNode[] {
  const blocks = (children: RootContent[]) =>
    children.flatMap((child) => blockToDoc(child, definitions));
  const inline = (children: PhrasingContent[]) => {
    const content = mergeText(inlineToDoc(children, [], definitions));
    return content.length > 0 ? { content } : {};
  };
  switch (node.type) {
    case "paragraph":
      return [{ type: "paragraph", ...inline(node.children) }];
    case "heading":
      return [{ type: "heading", attrs: { level: node.depth }, ...inline(node.children) }];
    case "blockquote":
      return [{ type: "blockquote", content: blocks(node.children) }];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "code":
      if (node.meta) throw unsupported(node, "A code fence with text after the language");
      return [
        {
          type: "codeBlock",
          attrs: { language: node.lang ?? null },
          ...(node.value && { content: [{ type: "text", text: node.value }] }),
        },
      ];
    case "list": {
      const tight = !node.spread && !node.children.some((item) => item.spread);
      const items = node.children.map((item): DocNode => {
        if (item.checked != null) throw unsupported(item, "A task list");
        const content = blocks(item.children);
        return {
          type: "listItem",
          content: content.length > 0 ? content : [{ type: "paragraph" }],
        };
      });
      return node.ordered
        ? [{ type: "orderedList", attrs: { start: node.start ?? 1, tight }, content: items }]
        : [{ type: "bulletList", attrs: { tight }, content: items }];
    }
    case "leafDirective": {
      const { figure, errors } = parseFigure(node.name, node.attributes ?? {});
      if (!figure) {
        const { line = 0, column = 0 } = node.position?.start ?? {};
        throw new MarkdownError(errors.map((message) => ({ line, column, message })));
      }
      return [{ type: "figure", attrs: { ...figure }, ...inline(node.children) }];
    }
    case "definition":
      // Reference links are inlined, so their definitions aren't needed.
      return [];
    default:
      throw unsupported(node, `Markdown "${node.type}"`);
  }
}

/** Parses a post body into TipTap JSON. Throws a `MarkdownError` for anything the editor lacks. */
export function markdownToDoc(markdown: string): DocNode {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkLeafDirective).parse(markdown);
  const definitions = new Map<string, Definition>();
  visit(tree, "definition", (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const content = tree.children.flatMap((node) => blockToDoc(node, definitions));
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/** The mdast node a mark opens. */
function markNode(mark: DocMark): Extract<PhrasingContent, Parents> {
  if (mark.type === "bold") return { type: "strong", children: [] };
  if (mark.type === "italic") return { type: "emphasis", children: [] };
  if (mark.type === "link") {
    const { href, title } = mark.attrs ?? {};
    return {
      type: "link",
      url: typeof href === "string" ? href : "",
      title: typeof title === "string" ? title : null,
      children: [],
    };
  }
  throw new Error(`The editor produced an unknown mark "${mark.type}"`);
}

/**
 * Rebuilds nested mdast from ProseMirror's flat marked text. Marks already open stay open while
 * they last; marks that start together nest by how long they last, longest outermost, so
 * `**[a](u) b**` keeps its shape.
 */
function inlineToMdast(nodes: DocNode[]): PhrasingContent[] {
  const root: PhrasingContent[] = [];
  const stack: { mark: DocMark; children: PhrasingContent[] }[] = [];
  const current = () => stack.at(-1)?.children ?? root;
  const runLength = (mark: DocMark, from: number) => {
    let end = from;
    while (end < nodes.length && (nodes[end]?.marks ?? []).some((m) => sameMark(m, mark))) end++;
    return end - from;
  };

  nodes.forEach((node, index) => {
    if (node.type === "hardBreak") {
      current().push({ type: "break" });
      return;
    }
    if (node.type !== "text") throw new Error(`The editor produced inline "${node.type}"`);
    const marks = node.marks ?? [];
    const wanted = marks.filter((mark) => mark.type !== "code");
    let keep = 0;
    while (keep < stack.length && wanted.some((mark) => sameMark(mark, stack[keep]?.mark))) {
      keep++;
    }
    stack.length = keep;
    const opening = wanted
      .filter((mark) => !stack.some((open) => sameMark(mark, open.mark)))
      .sort(
        (a, b) =>
          runLength(b, index) - runLength(a, index) ||
          MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
      );
    for (const mark of opening) {
      const parent = markNode(mark);
      current().push(parent);
      stack.push({ mark, children: parent.children });
    }
    const text = node.text ?? "";
    current().push(
      marks.some((mark) => mark.type === "code")
        ? { type: "inlineCode", value: text }
        : { type: "text", value: text },
    );
  });
  return root;
}

const textOf = (node: DocNode): string => node.text ?? (node.content ?? []).map(textOf).join("");

function blockToMdast(node: DocNode): RootContent[] {
  const blocks = () => (node.content ?? []).flatMap(blockToMdast);
  const inline = () => inlineToMdast(node.content ?? []);
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      // An empty paragraph is just the editor's spacing; Markdown has no such thing.
      return node.content?.length ? [{ type: "paragraph", children: inline() }] : [];
    case "heading": {
      const depth = Number(attrs.level);
      if (![1, 2, 3, 4, 5, 6].includes(depth)) throw new Error(`Bad heading level ${depth}`);
      return [{ type: "heading", depth: depth as 1 | 2 | 3 | 4 | 5 | 6, children: inline() }];
    }
    case "blockquote":
      return [{ type: "blockquote", children: blocks() as BlockContent[] }];
    case "horizontalRule":
      return [{ type: "thematicBreak" }];
    case "codeBlock":
      return [
        {
          type: "code",
          lang: typeof attrs.language === "string" && attrs.language ? attrs.language : null,
          meta: null,
          value: textOf(node),
        },
      ];
    case "bulletList":
    case "orderedList": {
      const spread = attrs.tight === false;
      const list: List = {
        type: "list",
        ordered: node.type === "orderedList",
        spread,
        children: (node.content ?? []).map((item): ListItem => ({
          type: "listItem",
          spread,
          children: blockToMdast(item).flatMap((child) =>
            child.type === "listItem" ? child.children : [],
          ),
        })),
      };
      if (list.ordered) list.start = typeof attrs.start === "number" ? attrs.start : 1;
      return [list];
    }
    case "listItem":
      return [{ type: "listItem", children: blocks() as BlockContent[] }];
    case "figure": {
      const caption = (node.content ?? []).map((child) =>
        child.type === "hardBreak" ? { type: "text", text: " " } : child,
      );
      const figure: LeafDirective = {
        type: "leafDirective",
        name: "figure",
        attributes: {
          src: String(attrs.src ?? ""),
          alt: String(attrs.alt ?? ""),
          size: String(attrs.size ?? "column"),
          w: String(attrs.w ?? ""),
          h: String(attrs.h ?? ""),
        },
        children: inlineToMdast(mergeText(caption)),
      };
      return [figure];
    }
    default:
      throw new Error(`The editor produced an unknown node "${node.type}"`);
  }
}

/** Serializes TipTap JSON to the Markdown that is stored in D1 and committed to git. */
export function docToMarkdown(doc: DocNode): string {
  const tree: Root = { type: "root", children: (doc.content ?? []).flatMap(blockToMdast) };
  return unified()
    .use(remarkStringify, STRINGIFY)
    .use(remarkGfm)
    .use(remarkLeafDirective)
    .stringify(tree);
}
