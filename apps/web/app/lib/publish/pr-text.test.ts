import { readingMinutes } from "@site/content-schema";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { postFile } from "../admin/post-file";
import { parsePostFile, snapshotOf } from "./post-parse";
import {
  PRIVATE_VALUE,
  buildPullRequest,
  buildRepublishComment,
  inlineText,
  pullRequestTitle,
  splitSections,
  wordCount,
} from "./pr-text";

const OWNER = "owner@example.com";
const isPrivate = (text: string) => text.toLowerCase().includes(OWNER);

const A = "blog/11111111-2222-4333-8444-555555555555.webp";
const B = "blog/22222222-3333-4444-8555-666666666666.gif";
const C = "blog/33333333-4444-4555-8666-777777777777.jpg";

const figure = (src: string, alt: string, caption = "", extra = "") =>
  `::figure${caption ? `[${caption}]` : ""}{src="${src}" alt="${alt}"${extra} w="2048" h="1365"}`;

const newBody = [
  "An intro with a few words, and @someone who shouldn't be pinged.",
  "",
  "## Why",
  "",
  "Because it is fun to build a lobby that never sleeps.",
  "",
  figure(A, "Two players in a [lobby]", "The lobby, *live*", ' size="wide"'),
  "",
  "```md",
  "## Not a heading",
  "```",
  "",
  "### How it works ###",
  "",
  "One object per room.",
  "",
  figure(B, "An animation"),
  "",
  "## Notes",
  "",
  "First notes.",
  "",
  "## Notes",
  "",
  "Second notes, now longer than before.",
].join("\n");

const post = snapshotOf(
  {
    title: "Durable  Objects:\na first look | @cloudflare",
    summary: "What I learned building the *game* lobby <b>, with [links](x) and ~tildes~.",
    category: "notes",
    tags: ["durable-objects", "workers"],
    bodyMd: newBody,
  },
  "2026-10-11",
);

const previous = snapshotOf(
  {
    title: "Durable Objects: first look",
    summary: `Write to ${OWNER} with questions.`,
    category: null,
    tags: ["durable-objects"],
    bodyMd: [
      "An intro with a few words, and @someone who shouldn't be pinged.",
      "",
      "## Why",
      "",
      "Because it is fun.",
      "",
      figure(C, `Old diagram, ask ${OWNER}`),
      "",
      `### Mail ${OWNER}`,
      "",
      "Removed words here.",
      "",
      "### How it works",
      "",
      "One object per room.",
      "",
      figure(B, "An animation"),
      "",
      "## Notes",
      "",
      "First notes.",
      "",
      "## Notes",
      "",
      "Second notes.",
    ].join("\n"),
  },
  "2026-10-11",
);

const updated = { ...post, updated: "2026-10-14" };
const slug = "durable-objects-a-first-look";
const path = `content/blog/2026-10-11-${slug}.md`;

describe("buildPullRequest", () => {
  it("describes a new post", async () => {
    const pr = buildPullRequest({ kind: "publish", slug, path, post });
    expect(pr.title).toBe("Publish: Durable Objects: a first look | @\u200Bcloudflare");
    await expect(pr.body).toMatchFileSnapshot("./fixtures/pr-publish.md");
  });

  it("describes an update, without printing private old values", async () => {
    const pr = buildPullRequest({
      kind: "update",
      slug,
      path,
      post: updated,
      previous,
      isPrivate,
    });
    expect(pr.title).toBe("Update: Durable Objects: a first look | @\u200Bcloudflare");
    expect(pr.body).not.toContain(OWNER);
    expect(pr.body).toContain(PRIVATE_VALUE);
    await expect(pr.body).toMatchFileSnapshot("./fixtures/pr-update.md");
  });

  it("describes an unpublish with no post text", async () => {
    const pr = buildPullRequest({
      kind: "unpublish",
      slug: "hello-world",
      path: "content/blog/2026-10-11-hello-world.md",
      title: "Hello, world",
      date: "2026-10-11",
      updated: "2026-10-12",
    });
    expect(pr.title).toBe("Unpublish: Hello, world");
    expect(pr.body).not.toContain("Hello, world");
    await expect(pr.body).toMatchFileSnapshot("./fixtures/pr-unpublish.md");
  });

  it("names an unpublish by its path when the title is missing or private", () => {
    const base = {
      kind: "unpublish" as const,
      slug: "hello-world",
      path: "content/blog/2026-10-11-hello-world.md",
      date: null,
      updated: null,
      isPrivate,
    };
    for (const title of [null, " ", `Mail ${OWNER.toUpperCase()}`]) {
      const pr = buildPullRequest({ ...base, title });
      expect(pr.title).toBe("Unpublish: content/blog/2026-10-11-hello-world.md");
      expect(pr.body).toContain("| Created | — |");
      expect(pr.body).not.toContain("| Updated |");
      expect(pr.body.toLowerCase()).not.toContain(OWNER);
    }
  });

  it("says when nothing changed", () => {
    const pr = buildPullRequest({ kind: "update", slug, path, post, previous: post });
    expect(pr.body).toContain("## What changed\n\nNo changes to the text or details.\n\n");
  });

  it("lists no sections or images when there are none", () => {
    const pr = buildPullRequest({ kind: "publish", slug, path, post: { ...post, body: "Hi." } });
    expect(pr.body).toContain("## Images\n\nNo images.\n\n");
    expect(pr.body).toContain("New post, 1 word.\n\nNo sections.\n\n");
  });

  it("cuts a long change list to fit GitHub's limit, and keeps the checklist", () => {
    const sections = (words: string) =>
      Array.from({ length: 3000 }, (_, i) => `## Section ${i}\n\n${words}`).join("\n\n");
    const pr = buildPullRequest({
      kind: "update",
      slug,
      path,
      post: { ...post, body: sections("new words") },
      previous: { ...post, body: sections("old") },
    });
    expect(pr.body.length).toBeLessThanOrEqual(60_000);
    expect(pr.body).toContain("- Edited **## Section 0** (+1 word)");
    expect(pr.body).toMatch(/\n\n…\(cut\)\n\n## Review checklist\n/);
    expect(pr.body).toContain("`ci` is green, then **Squash and merge**.");
  });

  it("states the reading time the build will show", () => {
    for (const words of [10, 327, 328, 700]) {
      const bodyMd = `\n\n${Array.from({ length: words }, () => "word").join(" ")}\n`;
      const file = postFile({ ...post, bodyMd, tags: post.tags, category: null }, "2026-10-11");
      if (!file.ok) throw new Error(file.errors.join());
      const parsed = parsePostFile(file.content);
      if (!parsed.ok) throw new Error(parsed.errors.join());
      const build = readingMinutes(matter(file.content).content);
      const pr = buildPullRequest({ kind: "publish", slug, path, post: parsed.post });
      expect(pr.body).toContain(`| Reading time | ${build} min |`);
    }
  });
});

describe("buildRepublishComment", () => {
  it("says what changed since the previous publish", async () => {
    const next = {
      ...post,
      summary: "A new summary.",
      body: `${post.body}\n\n## Setup\n\nInstall it.`,
    };
    const comment = buildRepublishComment(post, next, isPrivate);
    await expect(comment).toMatchFileSnapshot("./fixtures/pr-republish-comment.md");
  });

  it("redacts private previous values", () => {
    const comment = buildRepublishComment(previous, updated, isPrivate);
    expect(comment).not.toContain(OWNER);
    expect(comment).toContain(`| Summary | ${PRIVATE_VALUE} |`);
    expect(comment).toContain(`- Removed **${PRIVATE_VALUE}** (−3 words)`);
    expect(comment).toContain(`- Removed: ${PRIVATE_VALUE}`);
  });
});

describe("pullRequestTitle", () => {
  it("keeps titles to one line of at most 120 characters", () => {
    expect(pullRequestTitle("publish", "  A\n\ttitle  ")).toBe("Publish: A title");
    const long = pullRequestTitle("update", "word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).toMatch(/^Update: word word .* word…$/);
    // 9 + 1 + 2n characters: a cut at 119 would split the last emoji.
    const emoji = pullRequestTitle("publish", `x${"😀".repeat(80)}`);
    expect(emoji.length).toBeLessThanOrEqual(120);
    expect(emoji.endsWith("😀…")).toBe(true);
  });

  it("breaks mentions", () => {
    expect(pullRequestTitle("publish", "Thanks @octocat and @org/team, mail a@b.c")).toBe(
      "Publish: Thanks @\u200Boctocat and @\u200Borg/team, mail a@\u200Bb.c",
    );
    expect(pullRequestTitle("publish", "@ alone")).toBe("Publish: @ alone");
  });
});

describe("inlineText", () => {
  it("escapes Markdown, keeps one line and breaks mentions", () => {
    expect(inlineText("a | b\nc\t*d* _e_ `f` [g](h) <i> ~j~ \\k @l")).toBe(
      "a \\| b c \\*d\\* \\_e\\_ \\`f\\` \\[g\\](h) \\<i\\> \\~j\\~ \\\\k @\u200Bl",
    );
  });
});

describe("splitSections", () => {
  it("splits at H2 and H3 outside fenced code, keying repeated headings apart", () => {
    const sections = splitSections(newBody);
    expect(sections.map(({ key, heading, words }) => ({ key, heading, words }))).toEqual([
      { key: "", heading: null, words: 12 },
      // The figure line and the fenced block count as words too.
      { key: "## Why\n1", heading: "## Why", words: 28 },
      { key: "### How it works\n1", heading: "### How it works", words: 9 },
      { key: "## Notes\n1", heading: "## Notes", words: 2 },
      { key: "## Notes\n2", heading: "## Notes", words: 6 },
    ]);
    expect(sections[3]?.text).toBe("First notes.");
  });

  it("keeps an introduction only if it has words, and reads closing hashes like CommonMark", () => {
    expect(splitSections("\n\n## C#\n\nText.\n\n#### Deeper\n\n## Done ##")).toEqual([
      { key: "## C#\n1", heading: "## C#", words: 3, text: "Text.\n\n#### Deeper" },
      { key: "## Done\n1", heading: "## Done", words: 0, text: "" },
    ]);
  });

  it("counts words", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  one\ttwo\n\nthree ")).toBe(3);
  });
});
