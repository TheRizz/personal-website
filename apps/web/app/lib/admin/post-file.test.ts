import { postFrontmatter } from "@site/content-schema";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { localDate, normalizeTags, postFile, slugify } from "./post-file";

const draft = {
  title: 'Durable Objects: a "first" look',
  summary: "What I learned building the game lobby.",
  category: null,
  tags: ["Durable Objects", "durable-objects", "true", "!!!"],
  bodyMd: "## Why\n\nBecause *fun*.\n\n\n",
};

describe("postFile", () => {
  it("writes a file the build reads back to the same frontmatter", () => {
    const file = postFile(draft, "2026-10-12");
    if (!file.ok) throw new Error(file.errors.join());
    expect(file.filename).toBe("2026-10-12-durable-objects-a-first-look.md");
    expect(file.path).toBe("content/blog/2026-10-12-durable-objects-a-first-look.md");
    expect(file.content.endsWith("Because *fun*.\n")).toBe(true);

    const parsed = matter(file.content);
    const meta = postFrontmatter.parse(parsed.data);
    expect(meta.title).toBe(draft.title);
    expect(meta.summary).toBe(draft.summary);
    expect(meta.tags).toEqual(["durable-objects", "true"]);
    expect(meta.date.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(parsed.content.trim()).toBe("## Why\n\nBecause *fun*.");
  });

  it("keeps a category, a cover and a slug that is already set", () => {
    const file = postFile(
      { ...draft, category: " notes ", cover: "blog/x.webp", slug: "kept" },
      "2026-01-02",
    );
    if (!file.ok) throw new Error(file.errors.join());
    expect(file.filename).toBe("2026-01-02-kept.md");
    const meta = postFrontmatter.parse(matter(file.content).data);
    expect(meta.category).toBe("notes");
    expect(meta.cover).toBe("blog/x.webp");
  });

  it("says what is missing", () => {
    const file = postFile({ ...draft, title: " ", summary: "", bodyMd: "" }, "2026-10-12");
    expect(file).toEqual({
      ok: false,
      errors: ["Add a title.", "Add a summary.", "Write something in the body."],
    });
    const long = postFile({ ...draft, summary: "x".repeat(301) }, "2026-10-12");
    expect(long.ok).toBe(false);
  });
});

describe("helpers", () => {
  it("slugifies titles", () => {
    expect(slugify("Héllo, World!")).toBe("hello-world");
    expect(slugify("!!!")).toBe("post");
    expect(slugify("a".repeat(100)).length).toBe(80);
  });

  it("normalises tags like the post schema", () => {
    expect(normalizeTags(["Cloudflare Workers", "cloudflare-workers", "", "  "])).toEqual([
      "cloudflare-workers",
    ]);
  });

  it("formats the local date", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
