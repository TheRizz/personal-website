import { FIGURE_SIZES, PHOTOS_ORIGIN, variantKey, type FigureSize } from "@site/content-markdown";
import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { previewFor } from "~/lib/admin/images";

// The editor's view of an image section (design doc §4.9.6): the image, its alt text and size,
// buttons to move or remove it (dragging doesn't work on phones), and the caption below, which
// is the node's own inline content. The controls sit outside ProseMirror's editable content, and
// TipTap's node view lets their own events (typing, clicks) through without ProseMirror seeing
// them.

/** What the size picker shows for each size class. */
export const SIZE_LABELS: Record<FigureSize, string> = {
  column: "Column",
  wide: "Wide",
  full: "Full width",
};

/** Small bordered buttons and fields, sized for touch. */
const control =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-semibold text-fg transition-colors hover:bg-surface-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-surface [&_svg]:size-4";
const field =
  "block min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-base text-fg transition-colors hover:bg-surface-hover focus-visible:border-fg/40 aria-invalid:border-red-500/60";
const label = "mb-1 block text-sm font-semibold text-fg";

export function FigureView({
  node,
  editor,
  getPos,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps) {
  const { src, alt, size, w, h } = node.attrs as {
    src: string | null;
    alt: string;
    size: FigureSize;
    w: number | null;
    h: number | null;
  };
  const id = useId();
  // The alt input keeps its own text: a node view gets its new props a moment after a change,
  // too late for a controlled input, which would then lose the caret. When the node's alt
  // changes from elsewhere (undo, say), that wins. An empty alt never reaches the document, where
  // it would make the Markdown invalid: the figure keeps its last alt until a new one is typed.
  const [altText, setAltText] = useState(alt);
  const [nodeAlt, setNodeAlt] = useState(alt);
  if (alt !== nodeAlt) {
    setNodeAlt(alt);
    setAltText(alt);
  }
  const missingAlt = !altText.trim();

  // Whether there is a block to swap with on each side, kept current as the document changes.
  const canMove = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos();
      return {
        up: typeof pos === "number" && current.can().moveFigure("up", pos),
        down: typeof pos === "number" && current.can().moveFigure("down", pos),
      };
    },
  });

  const move = (direction: "up" | "down") => {
    const pos = getPos();
    if (!canMove[direction] || typeof pos !== "number") return;
    if (!editor.chain().moveFigure(direction, pos).run()) return;
    // Moving can draw the figure again from scratch, which drops the focus. Put it back on the
    // same button of the moved figure, which the command left selected.
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      const dom = editor.view.nodeDOM(editor.state.selection.from);
      if (dom instanceof HTMLElement && !dom.contains(document.activeElement)) {
        dom.querySelector<HTMLElement>(`[data-move="${direction}"]`)?.focus();
      }
    });
  };

  const remove = () => {
    deleteNode();
    editor.commands.focus();
  };

  const url = src && w ? (previewFor(src) ?? `${PHOTOS_ORIGIN}/${variantKey(src, w)}`) : undefined;

  return (
    <NodeViewWrapper
      as="figure"
      data-selected={selected || undefined}
      className="rounded-xl outline-offset-8 data-selected:outline-2 data-selected:outline-fg/50"
    >
      <div contentEditable={false} className="space-y-3">
        {url && (
          <img
            src={url}
            alt={alt}
            width={w ?? undefined}
            height={h ?? undefined}
            draggable={false}
            className="block h-auto max-w-full"
          />
        )}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="min-w-[min(100%,14rem)] flex-1">
            <label htmlFor={`${id}-alt`} className={label}>
              Alt text
            </label>
            <input
              id={`${id}-alt`}
              value={altText}
              onChange={(event) => {
                setAltText(event.target.value);
                if (event.target.value.trim()) updateAttributes({ alt: event.target.value });
              }}
              required
              aria-invalid={missingAlt || undefined}
              aria-describedby={missingAlt ? `${id}-alt-error` : undefined}
              className={field}
            />
          </div>
          <div>
            <label htmlFor={`${id}-size`} className={label}>
              Size
            </label>
            <select
              id={`${id}-size`}
              value={size}
              onChange={(event) => updateAttributes({ size: event.target.value })}
              className={field}
            >
              {FIGURE_SIZES.map((value) => (
                <option key={value} value={value}>
                  {SIZE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div role="group" aria-label="Image actions" className="flex flex-wrap gap-1">
            <button
              type="button"
              data-move="up"
              aria-disabled={!canMove.up || undefined}
              onClick={() => move("up")}
              className={control}
            >
              <ArrowUp aria-hidden="true" />
              Move up
            </button>
            <button
              type="button"
              data-move="down"
              aria-disabled={!canMove.down || undefined}
              onClick={() => move("down")}
              className={control}
            >
              <ArrowDown aria-hidden="true" />
              Move down
            </button>
            <button type="button" onClick={remove} className={control}>
              <Trash2 aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
        {missingAlt && (
          <p id={`${id}-alt-error`} className="text-sm text-red-700 dark:text-red-400">
            Alt text is required. Describe what the image shows for people who can&apos;t see it.
          </p>
        )}
      </div>
      <figcaption className="relative">
        {node.childCount === 0 && (
          <span
            aria-hidden="true"
            contentEditable={false}
            className="pointer-events-none absolute inset-x-6 top-0 select-none text-muted/70"
          >
            Caption (optional)
          </span>
        )}
        <NodeViewContent />
      </figcaption>
    </NodeViewWrapper>
  );
}
