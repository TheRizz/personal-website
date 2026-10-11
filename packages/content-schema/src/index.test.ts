import { describe, expect, it } from "vitest";
import { postFrontmatter } from "./index";

const valid = {
  title: "Hello",
  summary: "First post",
  date: "2026-10-11",
};

describe("postFrontmatter", () => {
  it("accepts a minimal post and applies defaults", () => {
    const post = postFrontmatter.parse(valid);
    expect(post.tags).toEqual([]);
    expect(post.draft).toBe(false);
    expect(post.date.toISOString().slice(0, 10)).toBe("2026-10-11");
  });

  it("normalises tags to kebab-case", () => {
    const post = postFrontmatter.parse({ ...valid, tags: ["Durable Objects", " React_Router "] });
    expect(post.tags).toEqual(["durable-objects", "react-router"]);
  });

  it.each([
    ["missing title", { summary: "x", date: "2026-10-11" }],
    ["bad date", { ...valid, date: "not a date" }],
    ["bad slug", { ...valid, slug: "Not A Slug" }],
    ["unknown field", { ...valid, categroy: "typo" }],
    ["empty tag", { ...valid, tags: ["!!!"] }],
  ])("rejects %s", (_name, input) => {
    expect(postFrontmatter.safeParse(input).success).toBe(false);
  });
});
