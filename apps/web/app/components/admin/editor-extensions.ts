import { FIGURE_SIZES, PHOTOS_ORIGIN, variantKey } from "@site/content-markdown";
import { Extension, Node, mergeAttributes } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

// The editor's schema: exactly what the Markdown bridge reads and writes (packages/content-
// markdown/src/bridge.ts). Anything else would be lost on save, so strike and underline are off.

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

/**
 * An image section (`::figure`), as the bridge produces it. Step 10.6 adds uploads and the
 * controls; until then figures from imported posts are kept, with an editable caption.
 */
const Figure = Node.create({
  name: "figure",
  group: "block",
  content: "inline*",
  marks: "bold italic link",
  draggable: false,
  isolating: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      size: { default: "column" },
      w: { default: null },
      h: { default: null },
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
];
