import { postFrontmatter, readingMinutes } from "@site/content-schema";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import helloWorld from "../../../../../content/blog/2026-10-11-hello-world.md?raw";
import { postFile } from "../admin/post-file";
import { parsePostFile, samePost, snapshotOf, splitFrontmatter } from "./post-parse";

// gray-matter with every other engine stubbed out, so a `---js` fixture is never evaluated, and
// with options, so its cache (keyed by text alone) doesn't hide one call from another.
const grayMatter = (text: string) =>
  matter(text, { engines: { javascript: () => ({}), toml: () => ({}) } });

const draft = {
  title: "  Durable Objects: a first look ",
  summary: " What I learned. ",
  category: " notes ",
  tags: ["Durable Objects", "durable-objects", "Workers"],
  cover: "blog/2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e.webp",
  bodyMd: "\n\n## Why\n\nBecause *fun*.\n\n```\n---\n```\n  \n\n",
};

describe("splitFrontmatter", () => {
  it.each([
    ["the writer's format", "---\ntitle: a\n---\n\nBody\n"],
    ["a BOM", "\uFEFF---\ntitle: a\n---\nBody"],
    ["CRLF line ends", "---\r\ntitle: a\r\n---\r\n\r\nBody\r\n"],
    ["no trailing newline", "---\ntitle: a\n---"],
    ["no closing delimiter", "---\ntitle: a\nsummary: b\n"],
    ["an empty frontmatter", "---\n---\nBody"],
    ["a `----` line", "----\ntitle: a\n----\nBody"],
    ["no frontmatter", "Body\n---\ntitle: a\n"],
    ["a closing line with more dashes", "---\ntitle: a\n-----\nBody"],
    ["a language", "---js\n{ title: 'a' }\n---\nBody"],
    ["spaces after the delimiter", "---  \ntitle: a\n---\nBody"],
    ["only the delimiter", "---"],
    ["nothing", ""],
  ])("splits %s as gray-matter does", (_name, text) => {
    const split = splitFrontmatter(text);
    const expected = grayMatter(text);
    expect(split?.content ?? text.replace(/^\uFEFF/, "")).toBe(expected.content);
    if (split) {
      expect(split.matter).toBe(expected.matter);
      if (split.language) expect(split.language).toBe(expected.language);
    } else {
      // gray-matter returns "" for "" without setting `matter`.
      expect(expected.matter ?? "").toBe("");
    }
  });

  it("reports the language after the opening delimiter", () => {
    expect(splitFrontmatter("---js\nx\n---\n")?.language).toBe("js");
    expect(splitFrontmatter("--- yaml \nx: 1\n---\n")?.language).toBe("yaml");
    expect(splitFrontmatter("---\nx: 1\n---\n")?.language).toBe("");
  });
});

describe("parsePostFile", () => {
  it("reads back exactly what postFile wrote", () => {
    for (const updated of [undefined, "2026-10-14"]) {
      for (const fields of [draft, { ...draft, category: null, cover: null, tags: [] }]) {
        const file = postFile(fields, "2026-10-11", { updated });
        if (!file.ok) throw new Error(file.errors.join());
        const parsed = parsePostFile(file.content);
        if (!parsed.ok) throw new Error(parsed.errors.join());
        expect(parsed.post).toStrictEqual(snapshotOf(fields, "2026-10-11", updated));
        expect(parsed.content).toBe(grayMatter(file.content).content);
        expect(parsed.draft).toBe(false);
        expect(parsed.frontmatterSlug).toBeUndefined();
      }
    }
  });

  it("normalises a snapshot the way postFile writes it", () => {
    expect(snapshotOf(draft, "2026-10-11")).toStrictEqual({
      title: "Durable Objects: a first look",
      summary: "What I learned.",
      date: "2026-10-11",
      category: "notes",
      tags: ["durable-objects", "workers"],
      cover: "blog/2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e.webp",
      body: "## Why\n\nBecause *fun*.\n\n```\n---\n```",
    });
  });

  it("reads a hand-written post like the build", () => {
    const parsed = parsePostFile(helloWorld);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const { data, content } = grayMatter(helloWorld);
    const meta = postFrontmatter.parse(data);
    expect(parsed.post.title).toBe(meta.title);
    expect(parsed.post.summary).toBe(meta.summary);
    expect(parsed.post.date).toBe(meta.date.toISOString().slice(0, 10));
    expect(parsed.post.updated).toBeUndefined();
    expect(parsed.post.tags).toEqual(meta.tags);
    expect(parsed.post.body).toBe(content.trim());
    expect(parsed.content).toBe(content);
    expect(readingMinutes(parsed.content)).toBe(1);
  });

  it("reads dates however YAML writes them", () => {
    const file = (date: string) => `---\ntitle: a\nsummary: b\ndate: ${date}\n---\nBody`;
    for (const date of ["2026-10-11", '"2026-10-11"', "2026-10-11T08:00:00Z"]) {
      const parsed = parsePostFile(file(date));
      expect(parsed.ok && parsed.post.date).toBe("2026-10-11");
    }
  });

  it("reports a custom slug and a draft flag", () => {
    const parsed = parsePostFile(
      "---\ntitle: a\nsummary: b\ndate: 2026-10-11\nslug: other\ndraft: true\n---\nBody",
    );
    expect(parsed).toMatchObject({ ok: true, frontmatterSlug: "other", draft: true });
  });

  it.each([
    ["no frontmatter", "Body only", "the file has no frontmatter"],
    [
      "a JavaScript frontmatter",
      "---js\n{ title: 'a' }\n---\nBody",
      "unsupported frontmatter language",
    ],
    [
      "invalid YAML",
      "---\ntitle: a\ntags: [a\n---\nBody",
      "the frontmatter isn't valid YAML (line 4)",
    ],
    [
      "an unknown key",
      "---\ntitle: a\nsummary: b\ndate: 2026-10-11\ncategroy: c\n---\n",
      "(root):",
    ],
    ["a missing title", "---\nsummary: b\ndate: 2026-10-11\n---\n", "title:"],
    ["only comments", "---\n# nothing\n---\nBody", "title:"],
    ["a list", "---\n- a\n---\nBody", "(root):"],
  ])("refuses %s", (_name, text, error) => {
    const parsed = parsePostFile(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain(error);
  });
});

describe("samePost", () => {
  const post = snapshotOf(draft, "2026-10-11");

  it("ignores `updated`", () => {
    expect(samePost(post, snapshotOf(draft, "2026-10-11", "2026-10-14"))).toBe(true);
    expect(samePost(snapshotOf(draft, "2026-10-11", "2026-10-12"), post)).toBe(true);
  });

  it("notices every other change", () => {
    expect(samePost(post, { ...post, title: "Other" })).toBe(false);
    expect(samePost(post, { ...post, date: "2026-10-12" })).toBe(false);
    expect(samePost(post, { ...post, category: undefined })).toBe(false);
    expect(samePost(post, { ...post, cover: undefined })).toBe(false);
    expect(samePost(post, { ...post, tags: [...post.tags].reverse() })).toBe(false);
    expect(samePost(post, { ...post, tags: post.tags.slice(1) })).toBe(false);
    expect(samePost(post, { ...post, body: `${post.body}\n\nMore.` })).toBe(false);
  });

  it("matches a hand-formatted file with the same content", () => {
    const parsed = parsePostFile(helloWorld);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const imported = {
      title: parsed.post.title,
      summary: parsed.post.summary,
      category: null,
      tags: parsed.post.tags,
      bodyMd: parsed.post.body,
    };
    expect(samePost(parsed.post, snapshotOf(imported, "2026-10-11", "2026-10-14"))).toBe(true);
  });
});
