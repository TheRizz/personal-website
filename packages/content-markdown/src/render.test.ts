import { readFileSync } from "node:fs";
import { bundledLanguages, createHighlighter } from "shiki";
import { describe, expect, it } from "vitest";
import { MarkdownError } from "./figure";
import { SHIKI_THEMES, renderMarkdown } from "./render";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

const UUID = "2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e";
const WIDE = `::figure[A *caption* with [inline](https://example.com) Markdown]{src="blog/${UUID}.webp" alt="What the image shows" size="wide" w="2048" h="1365"}`;

/** The first value of attribute `name` in some HTML. */
const attr = (html: string, name: string) => html.match(new RegExp(` ${name}="([^"]*)"`))?.[1];

async function issuesOf(markdown: string) {
  const error = await renderMarkdown(markdown).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MarkdownError);
  return (error as MarkdownError).issues;
}

describe("renderMarkdown", () => {
  it("renders the corpus byte for byte like the pipeline before figures", async () => {
    // kitchen-sink.golden.json was written by the old scripts/build-content.ts pipeline.
    const golden = JSON.parse(fixture("kitchen-sink.golden.json"));
    const highlighter = await createHighlighter({
      themes: Object.values(SHIKI_THEMES),
      langs: Object.keys(bundledLanguages),
    });
    const { html, headings, figures } = await renderMarkdown(fixture("kitchen-sink.md"), {
      highlighter,
    });
    expect(html).toBe(golden.html);
    expect(headings).toEqual(golden.headings);
    expect(figures).toEqual([]);
  }, 30_000);

  it("leaves times, ratios and other colons in prose alone", async () => {
    const { html } = await renderMarkdown("At 10:30am, 16:9 video, a::b and :smile:.\n\n:::note\n");
    expect(html).toBe("<p>At 10:30am, 16:9 video, a::b and :smile:.</p>\n<p>:::note</p>");
  });

  it("renders a wide figure with srcset, sizes and a caption", async () => {
    const { html, figures } = await renderMarkdown(`Before.\n\n${WIDE}\n\nAfter.`);
    const base = `https://photos.ry-mart.com/blog/${UUID}`;
    expect(html).toContain('<figure class="figure figure--wide">');
    expect(attr(html, "src")).toBe(`${base}-1024.webp`);
    expect(attr(html, "srcset")).toBe(
      `${base}-480.webp 480w, ${base}-1024.webp 1024w, ${base}-2048.webp 2048w`,
    );
    expect(attr(html, "sizes")).toBe("(min-width: 68.75rem) 68.75rem, 100vw");
    expect(html).toContain(
      'width="2048" height="1365" alt="What the image shows" loading="lazy" decoding="async">',
    );
    expect(html).toContain(
      '<figcaption>A <em>caption</em> with <a href="https://example.com">inline</a> Markdown</figcaption>',
    );
    expect(figures).toEqual([
      { src: `blog/${UUID}.webp`, alt: "What the image shows", size: "wide", w: 2048, h: 1365 },
    ]);
  });

  it("gives each size class its own class and sizes", async () => {
    const figure = (size: string) =>
      `::figure{src="blog/${UUID}.jpg" alt="A" size="${size}" w="1600" h="900"}`;
    const column = await renderMarkdown(
      `::figure{src="blog/${UUID}.jpg" alt="A" w="1600" h="900"}`,
    );
    const full = await renderMarkdown(figure("full"));
    expect(column.html).toContain('class="figure figure--column"');
    expect(full.html).toContain('class="figure figure--full"');
    expect(attr(full.html, "sizes")).toBe("100vw");
    expect(attr(column.html, "sizes")).not.toBe(attr(full.html, "sizes"));
    expect(attr(full.html, "srcset")).toMatch(
      /-480\.jpg 480w, .*-1024\.jpg 1024w, .*-1600\.jpg 1600w$/,
    );
  });

  it("gives a GIF or a small image one URL and no srcset", async () => {
    const gif = await renderMarkdown(`::figure{src="blog/${UUID}.gif" alt="A" w="800" h="600"}`);
    expect(attr(gif.html, "src")).toBe(`https://photos.ry-mart.com/blog/${UUID}.gif`);
    expect(gif.html).not.toContain("srcset");
    const small = await renderMarkdown(`::figure{src="blog/${UUID}.png" alt="A" w="400" h="300"}`);
    expect(attr(small.html, "src")).toBe(`https://photos.ry-mart.com/blog/${UUID}-400.png`);
    expect(small.html).not.toContain("srcset");
    expect(small.html).not.toContain("figcaption");
  });

  it("drops raw HTML in a caption and keeps it out of attributes", async () => {
    const { html } = await renderMarkdown(
      `::figure[<b>x</b> <img src=x onerror=alert(1)> \\] end]{src="blog/${UUID}.webp" alt="&#x22; onload=&#x22;alert(1)" w="2048" h="1365"}`,
    );
    expect(html).toContain("<figcaption>x  ] end</figcaption>");
    expect(html).toContain('alt="&#x22; onload=&#x22;alert(1)"');
    expect(html).not.toMatch(/<b>|onerror|" onload=/);
  });

  it.each([
    ["a URL src", `src="https://evil.example/a.webp" alt="A" w="1" h="1"`, /src must be/],
    ["a path outside blog/", `src="photos/${UUID}.webp" alt="A" w="1" h="1"`, /src must be/],
    ["an SVG", `src="blog/${UUID}.svg" alt="A" w="1" h="1"`, /src must be/],
    ["no src", `alt="A" w="1" h="1"`, /src must be/],
    ["no alt", `src="blog/${UUID}.webp" w="1" h="1"`, /non-empty alt/],
    ["a blank alt", `src="blog/${UUID}.webp" alt="  " w="1" h="1"`, /non-empty alt/],
    ["no w", `src="blog/${UUID}.webp" alt="A" h="1"`, /needs w and h/],
    ["no h", `src="blog/${UUID}.webp" alt="A" w="1"`, /needs w and h/],
    ["a w that isn't a number", `src="blog/${UUID}.webp" alt="A" w="wide" h="1"`, /needs w and h/],
    ["w over 2048", `src="blog/${UUID}.webp" alt="A" w="4032" h="1"`, /at most 2048/],
    ["an unknown size", `src="blog/${UUID}.webp" alt="A" size="huge" w="1" h="1"`, /size must be/],
    ["an unknown attribute", `src="blog/${UUID}.webp" alt="A" w="1" h="1" style="x"`, /"style"/],
  ])("fails a figure with %s, with its line", async (_, attributes, message) => {
    const issues = await issuesOf(`# Title\n\nText.\n\n::figure{${attributes}}\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      line: 5,
      column: 1,
      message: expect.stringMatching(message),
    });
  });

  it("fails an unknown directive and reports every bad line at once", async () => {
    const issues = await issuesOf(`::note[Hi]\n\nText.\n\n::figure{src="x"}\n`);
    expect(issues.map((issue) => issue.line)).toEqual([1, 5, 5, 5]);
    expect(issues[0]?.message).toMatch(/unknown directive "::note"/);
  });
});
