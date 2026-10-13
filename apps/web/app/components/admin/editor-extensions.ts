import { FIGURE_SIZES, PHOTOS_ORIGIN, variantKey } from "@site/content-markdown";
import { Fragment, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type Selection,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceAroundStep } from "@tiptap/pm/transform";
import { Extension, Node, ReactNodeViewRenderer, mergeAttributes } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { FigureView } from "./FigureView";

// The editor's schema: exactly what the Markdown bridge reads and writes (packages/content-
// markdown/src/bridge.ts). Anything else would be lost on save, so strike and underline are off.

declare module "@tiptap/react" {
  interface Commands<ReturnType> {
    figure: {
      /**
       * Swaps a figure with the block before or after it in the same parent. `pos` is the
       * figure's position; without it, the figure the selection is in or on, and a caret in its
       * caption moves with it. Otherwise the moved figure ends up selected.
       */
      moveFigure: (direction: "up" | "down", pos?: number) => ReturnType;
    };
  }
}

/** Lists keep `tight` (no blank lines between items), which the bridge writes back. */
const TightLists = Extension.create({
  name: "tightLists",
  addGlobalAttributes() {
    return [
      {
        types: ["bulletList", "orderedList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element) => element.getAttribute("data-tight") !== "false",
            renderHTML: (attributes) => ({ "data-tight": attributes.tight ? "true" : "false" }),
          },
        },
      },
    ];
  },
});

/** Position of the figure the selection is in (its caption) or on (selected whole), if any. */
export function selectedFigure(selection: Selection): number | null {
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === "figure" ? selection.from : null;
  }
  const { $from, $to } = selection;
  return $from.parent.type.name === "figure" && $from.sameParent($to) ? $from.before() : null;
}

/** The replacement that swaps the figure at `pos` with its neighbour, or null if it can't move. */
function figureSwap(doc: PMNode, pos: number, direction: "up" | "down") {
  const $pos = doc.resolve(pos);
  const figure = $pos.nodeAfter;
  if (figure?.type.name !== "figure") return null;
  const { parent } = $pos;
  const index = $pos.index();
  const other = direction === "up" ? index - 1 : index + 1;
  if (other < 0 || other >= parent.childCount) return null;
  const sibling = parent.child(other);
  const content = Fragment.from(direction === "up" ? [figure, sibling] : [sibling, figure]);
  // A list item must start with a paragraph, for example.
  if (!parent.canReplace(Math.min(index, other), Math.min(index, other) + 2, content)) return null;
  const from = direction === "up" ? pos - sibling.nodeSize : pos;
  return {
    from,
    to: from + content.size,
    content,
    figurePos: direction === "up" ? from : from + sibling.nodeSize,
  };
}

/**
 * An image section (`::figure`), as the bridge produces it. The node view (FigureView) adds the
 * preview, alt text, size and the move and remove buttons; renderHTML is for the clipboard.
 */
const Figure = Node.create({
  name: "figure",
  group: "block",
  content: "inline*",
  marks: "bold italic link",
  draggable: false,
  isolating: true,
  addAttributes() {
    // Read back as written (pasting a figure): TipTap would otherwise turn an alt of "1984"
    // into a number.
    const text = (name: string, fallback: string | null) => ({
      default: fallback,
      parseHTML: (element: HTMLElement) => element.getAttribute(name) ?? fallback,
    });
    const pixels = (name: string) => ({
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = element.getAttribute(name);
        return value && /^[1-9]\d{0,4}$/.test(value) ? Number(value) : null;
      },
    });
    return {
      src: text("src", null),
      alt: text("alt", ""),
      size: text("size", "column"),
      w: pixels("w"),
      h: pixels("h"),
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-src]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { src, alt, size, w, h } = node.attrs as {
      src: string | null;
      alt: string;
      size: string;
      w: number | null;
      h: number | null;
    };
    const sizeClass = (FIGURE_SIZES as readonly string[]).includes(size) ? size : "column";
    const url = src && w ? `${PHOTOS_ORIGIN}/${variantKey(src, w)}` : "";
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        class: `figure figure--${sizeClass}`,
        "data-src": src ?? "",
      }),
      ["img", { src: url, alt, width: w ?? undefined, height: h ?? undefined, draggable: "false" }],
      ["figcaption", 0],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FigureView);
  },
  addCommands() {
    return {
      moveFigure:
        (direction, pos) =>
        ({ tr, dispatch }) => {
          const at = pos ?? selectedFigure(tr.selection);
          if (at === null) return false;
          const swap = figureSwap(tr.doc, at, direction);
          if (!swap) return false;
          if (dispatch) {
            const { selection } = tr;
            const shift = swap.figurePos - at;
            const caretInCaption = pos === undefined && selection instanceof TextSelection;
            tr.replaceWith(swap.from, swap.to, swap.content);
            tr.setSelection(
              caretInCaption
                ? TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift)
                : NodeSelection.create(tr.doc, swap.figurePos),
            );
            tr.scrollIntoView();
          }
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    // Dragging doesn't work on phones, so moving is a command (design doc §4.9.6).
    return {
      "Alt-Shift-ArrowUp": () => this.editor.commands.moveFigure("up"),
      "Alt-Shift-ArrowDown": () => this.editor.commands.moveFigure("down"),
    };
  },
});

/** False for a transaction that turns a figure into another kind of block (see FigureKeys). */
export function keepsFigures(tr: Transaction): boolean {
  return tr.steps.every((step, index) => {
    if (!(step instanceof ReplaceAroundStep)) return true;
    const node = tr.docs[index]!.nodeAt(step.from);
    if (node?.type.name !== "figure" || step.from + node.nodeSize !== step.to) return true;
    return step.slice.content.firstChild?.type.name === "figure";
  });
}

/**
 * Keeps ordinary editing keys from breaking a figure, which the default keymap treats as any
 * other textblock: Enter in a caption would split it into two copies of the image, and Backspace
 * or Delete next to one would merge it with a paragraph and drop the image. Enter in a caption
 * starts a paragraph after the figure; Backspace and Delete at a caption's edge, or next to a
 * figure, select it instead, so a second press removes it. A separate extension, so that it runs
 * before the default keymap (priority 100) without moving the figure node in the schema.
 */
const FigureKeys = Extension.create({
  name: "figureKeys",
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        // A figure's caption is a textblock, so the heading, code block and list commands (and
        // their Markdown shortcuts) would turn the figure into one and drop its image. They
        // change a block's type with a ReplaceAroundStep over the whole node, so any such step
        // that turns a figure into something else is refused. Moving and removing a figure
        // replace it outright and still work.
        filterTransaction: keepsFigures,
      }),
    ];
  },
  addKeyboardShortcuts() {
    const { editor } = this;
    /** Selects the figure at `pos`, first removing the empty block the caret is in, if any. */
    const selectFigure = (pos: number, $caret?: ResolvedPos) =>
      editor.commands.command(({ tr }) => {
        let figurePos = pos;
        if ($caret && $caret.parent.content.size === 0) {
          const index = $caret.index(-1);
          if ($caret.node(-1).canReplace(index, index + 1)) {
            tr.delete($caret.before(), $caret.after());
            if ($caret.before() < pos) figurePos -= $caret.parent.nodeSize;
          }
        }
        tr.setSelection(NodeSelection.create(tr.doc, figurePos)).scrollIntoView();
        return true;
      });
    /** The caret, when the selection is an empty text selection. */
    const caret = () => {
      const { selection } = editor.state;
      return selection instanceof TextSelection && selection.empty ? selection.$from : null;
    };
    /** The block beside the caret's textblock in the same parent (`offset` -1 or 1). */
    const besideCaret = ($caret: ResolvedPos, offset: number) => {
      const index = $caret.index(-1) + offset;
      const parent = $caret.node(-1);
      return index >= 0 && index < parent.childCount ? parent.child(index) : null;
    };
    return {
      Enter: () => {
        // A new paragraph after the figure, rather than a second figure.
        const { $from, $to } = editor.state.selection;
        if ($from.parent.type.name !== "figure" || !$from.sameParent($to)) return false;
        const after = $from.after();
        return editor.commands.command(({ tr, state }) => {
          tr.insert(after, state.schema.nodes.paragraph!.create());
          tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
          return true;
        });
      },
      Backspace: () => {
        const $caret = caret();
        if (!$caret || $caret.parentOffset > 0 || editor.can().undoInputRule()) return false;
        // The default would turn a first figure with an empty caption into a paragraph.
        if ($caret.parent.type.name === "figure") return selectFigure($caret.before());
        const before = besideCaret($caret, -1);
        if (before?.type.name !== "figure") return false;
        return selectFigure($caret.before() - before.nodeSize, $caret);
      },
      Delete: () => {
        const $caret = caret();
        if (!$caret || $caret.parentOffset < $caret.parent.content.size) return false;
        // The default would delete a figure whose caption is empty.
        if ($caret.parent.type.name === "figure") return selectFigure($caret.before());
        if (besideCaret($caret, 1)?.type.name !== "figure") return false;
        return selectFigure($caret.after(), $caret);
      },
    };
  },
});

export const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    strike: false,
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null },
    },
  }),
  TightLists,
  Figure,
  FigureKeys,
];
