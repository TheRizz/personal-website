import { markdownToDoc } from "@site/content-markdown";
import { getSchema } from "@tiptap/react";
import { setBlockType, wrapIn } from "@tiptap/pm/commands";
import { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { editorExtensions, keepsFigures } from "./editor-extensions";

// The figure guard against the editor's real schema, without a browser.

const schema = getSchema(editorExtensions);
const SRC = "blog/2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e.webp";
const BODY = `Intro.\n\n::figure[A caption]{src="${SRC}" alt="1984" w="1024" h="683"}\n`;

function stateWithCaretInCaption() {
  const doc = PMNode.fromJSON(schema, markdownToDoc(BODY));
  let caption = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === "figure") caption = pos + 1;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, caption + 2) });
}

/** The transaction a command would dispatch, or null if it can't run. */
function run(
  state: EditorState,
  command: (s: EditorState, d: (tr: Transaction) => void) => boolean,
) {
  let result: Transaction | null = null;
  command(state, (tr) => (result = tr));
  return result as Transaction | null;
}

describe("keepsFigures", () => {
  it("refuses turning a figure into a heading or a code block", () => {
    const state = stateWithCaretInCaption();
    for (const type of [schema.nodes.heading!, schema.nodes.codeBlock!]) {
      const tr = run(state, setBlockType(type, type.name === "heading" ? { level: 2 } : {}));
      expect(tr).not.toBeNull();
      expect(keepsFigures(tr!)).toBe(false);
    }
  });

  it("allows a paragraph to change type, and a figure's attributes to change", () => {
    const state = stateWithCaretInCaption();
    const paragraph = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    expect(keepsFigures(run(paragraph, setBlockType(schema.nodes.heading!, { level: 2 }))!)).toBe(
      true,
    );
    const figurePos = state.selection.$from.before();
    expect(keepsFigures(state.tr.setNodeMarkup(figurePos, undefined, { alt: "New" }))).toBe(true);
  });

  it("allows removing a figure and quoting the paragraph before it", () => {
    const state = stateWithCaretInCaption();
    const figurePos = state.selection.$from.before();
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, figurePos)));
    expect(keepsFigures(selected.tr.deleteSelection())).toBe(true);
    const paragraph = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    expect(keepsFigures(run(paragraph, wrapIn(schema.nodes.blockquote!))!)).toBe(true);
  });
});

describe("figure attributes", () => {
  it("reads a pasted figure's attributes back as text and whole pixels", () => {
    const figure = schema.nodes.figure!;
    const rule = figure.spec.parseDOM![0]!;
    const element = {
      getAttribute: (name: string) =>
        ({ "data-src": SRC, src: SRC, alt: "1984", size: "wide", w: "1024", h: "683" })[name] ??
        null,
    } as unknown as HTMLElement;
    const attrs = (rule.getAttrs as (e: HTMLElement) => Record<string, unknown>)(element);
    expect(attrs).toMatchObject({ src: SRC, alt: "1984", size: "wide", w: 1024, h: 683 });
  });
});
