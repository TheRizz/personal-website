import { MarkdownError, renderMarkdown } from "@site/content-markdown";
import { describe, expect, it } from "vitest";
import bridge from "../../../../../packages/content-markdown/src/fixtures/bridge.md?raw";
import kitchenSink from "../../../../../packages/content-markdown/src/fixtures/kitchen-sink.md?raw";
import containers from "./fixtures/figures.md?raw";
import { figurePreviewUrl, figureSrcsOf, lintFigures, mentionedFigureSrcs } from "./figures";

const UUID = "2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e";
const SRC = `blog/${UUID}.webp`;
const WHOLE =
  'a line starting with "::" must be a whole ::figure[caption]{…}; write "\\::" for literal colons';

/** The figures the build renders, and the `<img src>` of each in its HTML. */
async function rendered(markdown: string) {
  const { figures, html } = await renderMarkdown(markdown);
  const images = html.matchAll(/<img src="(https:\/\/photos\.ry-mart\.com\/[^"]+)"/g);
  return { figures, srcs: [...images].map((match) => match[1]) };
}

describe("lintFigures", () => {
  it.each([
    ["bridge.md", bridge],
    ["kitchen-sink.md", kitchenSink],
    ["figures in quotes and lists", containers],
  ])("finds the figures the build renders in %s", async (_name, markdown) => {
    const { figures, errors } = lintFigures(markdown);
    expect(errors).toEqual([]);
    const build = await rendered(markdown);
    expect(figures.map(({ caption: _caption, line: _line, ...figure }) => figure)).toEqual(
      build.figures,
    );
    expect(figures.map(figurePreviewUrl)).toEqual(build.srcs);
  });

  it("keeps captions as Markdown, with their lines", () => {
    expect(lintFigures(bridge).figures.map(({ caption, line }) => ({ caption, line }))).toEqual([
      { caption: "A *caption* with [inline](https://example.com) Markdown", line: 13 },
      { caption: "", line: 15 },
    ]);
    const nested = lintFigures(containers).figures[3];
    expect(nested?.caption).toBe("A [nested \\] bracket] caption");
    expect(nested?.alt).toBe('Nested & Animated "GIF"');
  });

  it("reports the build's errors on the build's lines", async () => {
    const markdown = [
      "Intro.",
      "",
      `::figure{src="blog/x.webp" alt="" w="1" h="1"}`,
      "",
      `> ::figure{src="${SRC}" alt="Too wide" w="3000" h="1"}`,
      "",
      `- ::figure{id=x src="${SRC}" alt="An id" w="10" h="10"}`,
      "",
      "::note[Not a figure]",
    ].join("\n");
    const error = await renderMarkdown(markdown).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarkdownError);
    const issues = (error as MarkdownError).issues.map(({ line, message }) => ({ line, message }));
    const lint = lintFigures(markdown);
    expect(lint.errors).toEqual(issues);
    expect(lint.figures).toEqual([]);
  });

  it.each([
    ["trailing text", `::figure{src="${SRC}" alt="a" w="1" h="1"} and more`],
    ["an unclosed label", "::figure[caption"],
    ["unclosed attributes", `::figure{src="${SRC}" alt="a"`],
    ["an unclosed quote", `::figure{src="${SRC} alt="a"}`],
    ["text glued to a quoted value", `::figure{src="${SRC}"alt="a"}`],
    ["a quote in an unquoted value", `::figure{alt=a"b"}`],
  ])("refuses a line with %s", (_name, line) => {
    expect(lintFigures(`Text.\n\n${line}\n`)).toEqual({
      figures: [],
      errors: [{ line: 3, message: WHOLE }],
    });
  });

  it.each([
    ["an escaped directive", `\\::figure{src="x"}`],
    ["a space after the colons", ":: x"],
    ["three colons", ":::note"],
    ["colons mid-line", "a::b and ::figure{src=x}"],
    ["a fenced figure", "```\n::figure{src=x}\n```"],
    ["a figure in a tilde fence", "~~~md\n```\n::figure{src=x}\n~~~"],
  ])("skips %s", (_name, markdown) => {
    expect(lintFigures(markdown)).toEqual({ figures: [], errors: [] });
  });

  it("ends a fence only with the same character, at least as long", () => {
    const markdown = ["````", "```", "::figure{src=x}", "~~~~", "````", "::note"].join("\n");
    expect(lintFigures(markdown).errors.map((error) => error.line)).toEqual([6]);
  });

  it("decodes numeric references and a few named ones, and leaves other names", () => {
    const line = `::figure{src="${SRC}" alt="&#x22;q&#34; &lt;b&gt; &apos;&amp;&nbsp;&copy;&#0;" w="10" h="10"}`;
    expect(lintFigures(line).figures[0]?.alt).toBe(`"q" <b> '&\u00A0&copy;\uFFFD`);
  });

  it("reads ids, classes and bare keys like the build, which refuses them", () => {
    const { errors } = lintFigures(`::figure{#a .b .c hidden src="${SRC}" alt="a" w="1" h="1"}`);
    expect(errors.map((error) => error.message)).toEqual([
      '::figure has an unknown attribute "id"',
      '::figure has an unknown attribute "class"',
      '::figure has an unknown attribute "hidden"',
    ]);
  });
});

describe("figure keys", () => {
  it("lists each valid figure's key once, in order", () => {
    expect(figureSrcsOf(containers)).toEqual([
      "blog/11111111-2222-4333-8444-555555555555.webp",
      "blog/22222222-3333-4444-8555-666666666666.jpg",
      "blog/33333333-4444-4555-8666-777777777777.png",
      "blog/44444444-5555-4666-8777-888888888888.gif",
    ]);
  });

  it("finds keys mentioned anywhere", () => {
    const text = [
      `A link to https://photos.ry-mart.com/${SRC} and \`${SRC}\`.`,
      "```",
      '::figure{src="blog/55555555-6666-4777-8888-999999999999.gif"}',
      "```",
      `${SRC} again, and blog/${UUID.toUpperCase()}.webp in capitals, and blog/${UUID}.svg`,
    ].join("\n");
    expect(mentionedFigureSrcs(text)).toEqual([
      SRC,
      "blog/55555555-6666-4777-8888-999999999999.gif",
    ]);
    expect(mentionedFigureSrcs("No images.")).toEqual([]);
  });

  it("previews the variant the post shows", () => {
    expect(figurePreviewUrl({ src: SRC, w: 2048 })).toBe(
      `https://photos.ry-mart.com/blog/${UUID}-1024.webp`,
    );
    expect(figurePreviewUrl({ src: SRC, w: 700 })).toBe(
      `https://photos.ry-mart.com/blog/${UUID}-700.webp`,
    );
    expect(figurePreviewUrl({ src: `blog/${UUID}.gif`, w: 2048 })).toBe(
      `https://photos.ry-mart.com/blog/${UUID}.gif`,
    );
  });
});
