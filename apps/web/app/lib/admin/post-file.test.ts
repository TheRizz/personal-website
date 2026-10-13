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

  it("writes the keys in a fixed order, with bare dates", () => {
    const file = postFile({ ...draft, category: "notes", cover: "blog/x.webp" }, "2026-10-11", {
      updated: "2026-10-14",
    });
    if (!file.ok) throw new Error(file.errors.join());
    expect(file.content).toBe(
      [
        "---",
        'title: "Durable Objects: a \\"first\\" look"',
        'summary: "What I learned building the game lobby."',
        "date: 2026-10-11",
        "updated: 2026-10-14",
        'category: "notes"',
        'tags: ["durable-objects","true"]',
        'cover: "blog/x.webp"',
        "---",
        "",
        "## Why",
        "",
        "Because *fun*.",
        "",
      ].join("\n"),
    );
  });

  it("round-trips `updated` through gray-matter and keeps `date`", () => {
    for (const updated of [undefined, "2026-10-14"]) {
      const file = postFile(draft, "2026-10-11", { updated });
      if (!file.ok) throw new Error(file.errors.join());
      expect(file.filename).toBe("2026-10-11-durable-objects-a-first-look.md");
      const meta = postFrontmatter.parse(matter(file.content).data);
      expect(meta.date.toISOString().slice(0, 10)).toBe("2026-10-11");
      expect(meta.updated?.toISOString().slice(0, 10)).toBe(updated);
      expect(file.content.includes("updated:")).toBe(updated !== undefined);
      expect(file.content).not.toMatch(/^(slug|draft):/m);
    }
  });

  it("keeps the path of a post on main whose file name doesn't match its date", () => {
    const path = "content/blog/2026-10-11-foo.md";
    const file = postFile({ ...draft, slug: "foo" }, "2026-10-09", { updated: "2026-10-13", path });
    if (!file.ok) throw new Error(file.errors.join());
    expect(file.filename).toBe("2026-10-11-foo.md");
    expect(file.path).toBe(path);
    const meta = postFrontmatter.parse(matter(file.content).data);
    expect(meta.date.toISOString().slice(0, 10)).toBe("2026-10-09");
  });

  it("refuses dates that aren't real and slugs that aren't valid", () => {
    expect(postFile(draft, "2026-02-30")).toEqual({
      ok: false,
      errors: ["The date must be a real date written as YYYY-MM-DD."],
    });
    expect(postFile(draft, "2026-10-11", { updated: "14/10/2026" })).toEqual({
      ok: false,
      errors: ["The updated date must be a real date written as YYYY-MM-DD."],
    });
    for (const slug of ["Not A Slug", "", "a".repeat(81)]) {
      const file = postFile({ ...draft, slug }, "2026-10-11");
      expect(file.ok).toBe(false);
    }
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
