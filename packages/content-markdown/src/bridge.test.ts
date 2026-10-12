import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc, type DocNode } from "./bridge";
import { MarkdownError } from "./figure";
import { renderMarkdown } from "./render";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

const BLOG = new URL("../../../content/blog/", import.meta.url);

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

const paragraph = (...content: DocNode[]): DocNode => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});

/** Hand-written Markdown in other styles than the bridge writes. */
const MESSY = `Setext heading
==============

* star bullets
* with _underscore emphasis_ and __underscore strong__

+ plus bullets

***

~~~js
tilde fence
~~~

A <https://ry-mart.com> autolink, a bare https://example.org and a [reference][r].

[r]: https://example.net "Ref"

1) parenthesis list
2) second
`;

describe("markdownToDoc / docToMarkdown", () => {
  it("round-trips the bridge's own Markdown byte for byte", () => {
    const markdown = fixture("bridge.md");
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it.each(readdirSync(BLOG).filter((name) => name.endsWith(".md")))(
    "imports %s with the same HTML, or refuses it",
    async (name) => {
      const body = readFileSync(new URL(name, BLOG), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
      let once: string;
      try {
        once = roundTrip(body);
      } catch (error) {
        expect(error).toBeInstanceOf(MarkdownError);
        return;
      }
      expect(roundTrip(once)).toBe(once);
      expect((await renderMarkdown(once)).html).toBe((await renderMarkdown(body)).html);
    },
  );

  it.each([
    ["the bridge corpus", fixture("bridge.md")],
    ["Markdown in other styles", MESSY],
  ])("is idempotent and keeps the rendered HTML for %s", async (_, markdown) => {
    const once = roundTrip(markdown);
    expect(roundTrip(once)).toBe(once);
    expect((await renderMarkdown(once)).html).toBe((await renderMarkdown(markdown)).html);
  });

  it("normalises other styles to - bullets, * emphasis, backtick fences and - rules", () => {
    const markdown = roundTrip(MESSY);
    expect(markdown).toContain(
      "- star bullets\n- with *underscore emphasis* and **underscore strong**",
    );
    expect(markdown).toContain("\n---\n");
    expect(markdown).toContain("```js\ntilde fence\n```");
    expect(markdown).toContain('[reference](https://example.net "Ref")');
    expect(markdown).not.toContain("[r]:");
  });

  it.each([
    "# not a heading",
    "1. not a list",
    "- not a bullet",
    "+ not a bullet either",
    "> not a quote",
    "**not bold**, *not italic* and _not either_",
    "`not code`",
    "[not a link](/about)",
    "<b>not HTML</b>",
    "&copy; is not an entity",
    '::figure[not an image]{src="blog/x.webp"}',
    "---",
    "~~not struck~~",
    "| not | a table |",
    "```not a fence",
    "a \\ backslash and \\* an escape",
    "16:9 video at 10:30am, a::b",
  ])("keeps typed %j as text", async (text) => {
    const doc = paragraph({ type: "text", text });
    const markdown = docToMarkdown(doc);
    expect(markdownToDoc(markdown)).toEqual(doc);
    const { html } = await renderMarkdown(markdown);
    expect(html.replace(/^<p>|<\/p>$/g, "")).not.toMatch(/<(?!\/?p>)/);
  });

  it("nests marks so the HTML keeps its shape", () => {
    const doc = paragraph(
      {
        type: "text",
        text: "A bold link",
        marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://e.com", title: null } }],
      },
      { type: "text", text: " then more bold", marks: [{ type: "bold" }] },
      { type: "text", text: " plain " },
      { type: "text", text: "code", marks: [{ type: "code" }] },
    );
    expect(docToMarkdown(doc)).toBe(
      "**[A bold link](https://e.com) then more bold** plain `code`\n",
    );
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });

  it("maps every editor node", () => {
    const doc = markdownToDoc(fixture("bridge.md"));
    const types = new Set<string>();
    const walk = (node: DocNode) => {
      types.add(node.type);
      node.marks?.forEach((mark) => types.add(mark.type));
      node.content?.forEach(walk);
    };
    walk(doc);
    expect([...types].sort()).toEqual(
      [
        ...["blockquote", "bold", "bulletList", "code", "codeBlock", "doc", "figure", "hardBreak"],
        ...["heading", "horizontalRule", "italic", "link", "listItem", "orderedList", "paragraph"],
        "text",
      ].sort(),
    );
    const figure = doc.content?.find((node) => node.type === "figure");
    expect(figure).toMatchObject({
      attrs: {
        src: "blog/2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e.webp",
        alt: "What the image shows",
        size: "wide",
        w: 2048,
        h: 1365,
      },
      content: [
        { type: "text", text: "A " },
        { type: "text", text: "caption", marks: [{ type: "italic" }] },
        { type: "text", text: " with " },
        { type: "text", text: "inline", marks: [{ type: "link" }] },
        { type: "text", text: " Markdown" },
      ],
    });
  });

  it("writes a figure from the editor with every attribute and a one-line caption", () => {
    const markdown = docToMarkdown({
      type: "doc",
      content: [
        {
          type: "figure",
          attrs: { src: "blog/a.webp", alt: 'Say "hi"', size: "full", w: 1024, h: 768 },
          content: [
            { type: "text", text: "Line one" },
            { type: "hardBreak" },
            { type: "text", text: "two ]" },
          ],
        },
        { type: "paragraph" },
      ],
    });
    expect(markdown).toBe(
      '::figure[Line one two \\]]{src="blog/a.webp" alt="Say &#x22;hi&#x22;" size="full" w="1024" h="768"}\n',
    );
  });

  it.each([
    ["a table", "Text.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", 3],
    ["raw HTML", "Text.\n\n<div>x</div>\n", 3],
    ["an image", "Text.\n\n![alt](https://e.com/a.png)\n", 3],
    ["a task list", "- [ ] task\n", 1],
    ["a code fence with meta", "```js title=x\n1\n```\n", 1],
    ["strikethrough", "~~gone~~\n", 1],
    ["a bad figure", '::figure{src="https://e.com/a.webp" alt="A" w="1" h="1"}\n', 1],
  ])("refuses %s with its line", (_, markdown, line) => {
    const error = (() => {
      try {
        markdownToDoc(markdown);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(MarkdownError);
    expect((error as MarkdownError).issues[0]?.line).toBe(line);
  });
});
