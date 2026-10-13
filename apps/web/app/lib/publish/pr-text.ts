import { readingMinutes } from "@site/content-schema";
import { figurePreviewUrl, lintFigures, type LintedFigure } from "./figures";
import type { PostSnapshot } from "./post-parse";
import { isIsoDate, isSlug, postUrl } from "./post-path";

// The pull request a publish opens (design doc §4.9.7): its title, which is also the commit
// message, and a body the owner reviews on GitHub, from a phone too. Both are built from the post
// alone, never from draft ids, other drafts or the owner's address. Post text is escaped so it
// can't add links, HTML or @-mentions, and every value printed from the previous version passes
// through `isPrivate`, so an edit that removes a private address can still publish.

/** Printed instead of a previous value that holds the owner's private address. */
export const PRIVATE_VALUE = "(contains a private address)";

export type PrKind = "publish" | "update" | "unpublish";

export type PullRequestInput =
  | { kind: "publish"; slug: string; path: string; post: PostSnapshot }
  | {
      kind: "update";
      slug: string;
      path: string;
      post: PostSnapshot;
      previous: PostSnapshot;
      isPrivate?: (text: string) => boolean;
    }
  | {
      kind: "unpublish";
      slug: string;
      path: string;
      title: string | null;
      date: string | null;
      updated: string | null;
      isPrivate?: (text: string) => boolean;
    };

const MAX_TITLE = 120;
/** GitHub refuses bodies over 65,536 characters; this leaves room. */
const MAX_BODY = 60_000;
const CUT = "…(cut)";
const NONE = "—";
const PREFIX: Record<PrKind, string> = {
  publish: "Publish",
  update: "Update",
  unpublish: "Unpublish",
};

const CI_ITEM = "- [ ] `ci` is green, then **Squash and merge**.";
const POST_CHECKLIST = [
  "- [ ] It reads well.",
  "- [ ] Alt text and captions are right.",
  "- [ ] Summary and tags are right.",
  "- [ ] Nothing private in the text or images.",
  CI_ITEM,
];
const UNPUBLISH_CHECKLIST = ["- [ ] It's the right post.", CI_ITEM];
const UNPUBLISH_NOTE = "The post leaves the site on the next deploy and stays in git history.";

const notPrivate = () => false;

/** Puts a zero-width space after an `@` that starts a name, so GitHub doesn't notify anyone. */
const breakMentions = (text: string) => text.replace(/@(?=[A-Za-z0-9])/g, "@\u200B");

/** Turns line breaks and tabs (and the spaces around them) into one space. */
const oneLine = (text: string) => text.replace(/[ \t]*[\r\n\t][ \t\r\n]*/g, " ");

/** A post value as plain Markdown text: one line, no formatting, links, HTML or mentions. */
export function inlineText(text: string): string {
  return breakMentions(oneLine(text).replace(/[\\`*_[\]<>|~]/g, "\\$&"));
}

/** Alt text inside `![…]`. */
const altText = (alt: string) => breakMentions(oneLine(alt).replace(/[\\[\]]/g, "\\$&"));

/** A tag or a path as code; anything unexpected is escaped as text instead. */
const code = (value: string) =>
  /^[A-Za-z0-9/._-]+$/.test(value) ? `\`${value}\`` : inlineText(value);

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/** `+5`, `−80` (a real minus sign) or `±0`. */
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

/** `Publish: <title>` and so on: one line, no mentions, at most 120 characters. */
export function pullRequestTitle(kind: PrKind, title: string): string {
  const text = `${PREFIX[kind]}: ${breakMentions(title.replace(/\s+/g, " ").trim())}`;
  if (text.length <= MAX_TITLE) return text;
  let cut = text.slice(0, MAX_TITLE - 1);
  // At a word break if there is one near the end; never inside a surrogate pair.
  const space = cut.lastIndexOf(" ");
  if (space > MAX_TITLE - 30) cut = cut.slice(0, space);
  else if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Words as the PR counts them: runs of non-whitespace. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A part of a body: the text before the first heading, or an H2/H3 heading and what follows. */
export interface Section {
  /** `""` for the introduction; otherwise the heading and its occurrence, unique in the body. */
  key: string;
  /** `## Why`, or null for the introduction. */
  heading: string | null;
  words: number;
  /** The section's Markdown without its heading line, trimmed of blank lines. */
  text: string;
}

const HEADING = /^ {0,3}(#{2,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Splits a body at its H2 and H3 headings, outside fenced code. The introduction is kept only if
 * it has words. A heading used twice gets a second key, so both can be compared.
 */
export function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  const seen = new Map<string, number>();
  let current: { key: string; heading: string | null; lines: string[] } = {
    key: "",
    heading: null,
    lines: [],
  };
  const finish = () => {
    const text = current.lines
      .join("\n")
      .replace(/^(?:[ \t]*\n)+/, "")
      .replace(/\s+$/, "");
    const words = wordCount(text);
    if (current.heading !== null || words > 0) {
      sections.push({ key: current.key, heading: current.heading, words, text });
    }
  };
  let fence: { marker: string; length: number } | null = null;
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close?.startsWith(fence.marker) && close.length >= fence.length) fence = null;
    } else {
      const [, sequence, info] = FENCE_OPEN.exec(line) ?? [];
      // A backtick fence's info string can't hold a backtick.
      if (sequence && !(sequence.startsWith("`") && info?.includes("`"))) {
        fence = { marker: sequence.charAt(0), length: sequence.length };
      } else {
        const match = HEADING.exec(line);
        if (match?.[1] && match[2]) {
          finish();
          const heading = `${match[1]} ${match[2]}`;
          const occurrence = (seen.get(heading) ?? 0) + 1;
          seen.set(heading, occurrence);
          current = { key: `${heading}\n${occurrence}`, heading, lines: [] };
          continue;
        }
      }
    }
    current.lines.push(line);
  }
  finish();
  return sections;
}

/** A table without a header row, for the overview. */
const overviewTable = (rows: [string, string][]) =>
  ["| | |", "| --- | --- |", ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join("\n");

const urlOf = (slug: string) => (isSlug(slug) ? postUrl(slug) : inlineText(postUrl(slug)));

function postOverview(slug: string, path: string, post: PostSnapshot): string {
  const rows: [string, string][] = [
    ["URL", urlOf(slug)],
    ["Summary", inlineText(post.summary)],
    ["Category", post.category ? inlineText(post.category) : NONE],
    ["Tags", post.tags.length > 0 ? post.tags.map(code).join(", ") : NONE],
    // The build counts gray-matter's content, which is the body between two newlines.
    ["Reading time", `${readingMinutes(`\n${post.body}\n`)} min`],
    ["Created", inlineText(post.date)],
    ...(post.updated ? [["Updated", inlineText(post.updated)] as [string, string]] : []),
    ["File", code(path)],
  ];
  return overviewTable(rows);
}

function imageBlocks(figures: LintedFigure[]): string {
  if (figures.length === 0) return "No images.";
  return figures
    .map((figure) => {
      const image = `![${altText(figure.alt)}](${figurePreviewUrl(figure)})`;
      // Captions keep their Markdown; they are only kept to one line and stripped of mentions.
      const caption = breakMentions(oneLine(figure.caption)).trim();
      return caption ? `${image}\n> ${caption}` : image;
    })
    .join("\n\n");
}

function newPostChanges(post: PostSnapshot): string {
  const headings = splitSections(post.body).flatMap((section) =>
    section.heading === null ? [] : [`- ${inlineText(section.heading)}`],
  );
  return [
    `New post, ${plural(wordCount(post.body), "word")}.`,
    headings.length > 0 ? headings.join("\n") : "No sections.",
  ].join("\n\n");
}

const FIELDS = [
  ["title", "Title"],
  ["summary", "Summary"],
  ["date", "Date"],
  ["updated", "Updated"],
  ["category", "Category"],
  ["tags", "Tags"],
  ["cover", "Cover"],
] as const;

type Field = (typeof FIELDS)[number][0];

/** Prints a value of the previous version: redacted when private, escaped otherwise. */
type PrintOld = (text: string) => string;

const fieldValue = (post: PostSnapshot, field: Field): string | undefined =>
  field === "tags" ? (post.tags.length > 0 ? post.tags.join(", ") : undefined) : post[field];

/** A `| Field | Before | After |` table of the frontmatter fields that changed, or null. */
function fieldTable(previous: PostSnapshot, next: PostSnapshot, printOld: PrintOld) {
  const rows = FIELDS.flatMap(([field, label]) => {
    const before = fieldValue(previous, field);
    const after = fieldValue(next, field);
    if (before === after) return [];
    const cells = [label, before === undefined ? NONE : printOld(before)];
    cells.push(after === undefined ? NONE : inlineText(after));
    return [`| ${cells.join(" | ")} |`];
  });
  if (rows.length === 0) return null;
  return ["| Field | Before | After |", "| --- | --- | --- |", ...rows].join("\n");
}

const words = (n: number, count: string) => `${count} ${Math.abs(n) === 1 ? "word" : "words"}`;

/** One bullet per section added, edited or removed: the new version's order, then removals. */
function sectionBullets(previous: string, next: string, printOld: PrintOld): string[] {
  const oldSections = new Map(splitSections(previous).map((section) => [section.key, section]));
  const newSections = splitSections(next);
  const newKeys = new Set(newSections.map((section) => section.key));
  const name = (section: Section, print: (text: string) => string) =>
    section.heading === null ? "Introduction" : print(section.heading);
  const bullets: string[] = [];
  for (const section of newSections) {
    const old = oldSections.get(section.key);
    if (!old) {
      const change = words(section.words, `+${section.words}`);
      bullets.push(`- Added **${name(section, inlineText)}** (${change})`);
    } else if (old.text !== section.text) {
      const change = section.words - old.words;
      bullets.push(`- Edited **${name(section, inlineText)}** (${words(change, signed(change))})`);
    }
  }
  for (const old of oldSections.values()) {
    if (newKeys.has(old.key)) continue;
    bullets.push(`- Removed **${name(old, printOld)}** (${words(old.words, `−${old.words}`)})`);
  }
  return bullets;
}

/** Figures added or removed, by image key, named by their alt text. */
function figureBullets(previous: string, next: string, printOld: PrintOld): string[] {
  const oldFigures = lintFigures(previous).figures;
  const newFigures = lintFigures(next).figures;
  const oldSrcs = new Set(oldFigures.map((figure) => figure.src));
  const newSrcs = new Set(newFigures.map((figure) => figure.src));
  const onePerSrc = (figures: LintedFigure[]) => [
    ...new Map(figures.map((figure) => [figure.src, figure])).values(),
  ];
  const added = onePerSrc(newFigures.filter((figure) => !oldSrcs.has(figure.src)));
  const removed = onePerSrc(oldFigures.filter((figure) => !newSrcs.has(figure.src)));
  return [
    ...added.map((figure) => `- Added: ${inlineText(figure.alt)}`),
    ...removed.map((figure) => `- Removed: ${printOld(figure.alt)}`),
  ];
}

/** The update diff: changed details, body sections and figures. */
function updateChanges(
  previous: PostSnapshot,
  next: PostSnapshot,
  isPrivate: (text: string) => boolean,
): string {
  const printOld: PrintOld = (text) => (isPrivate(text) ? PRIVATE_VALUE : inlineText(text));
  const parts: string[] = [];
  const table = fieldTable(previous, next, printOld);
  if (table) parts.push(table);
  if (previous.body !== next.body) {
    parts.push(`**Body** (${wordCount(previous.body)} → ${wordCount(next.body)} words)`);
    const bullets = sectionBullets(previous.body, next.body, printOld);
    if (bullets.length > 0) parts.push(bullets.join("\n"));
  }
  const images = figureBullets(previous.body, next.body, printOld);
  if (images.length > 0) parts.push(`**Images**\n\n${images.join("\n")}`);
  return parts.length > 0 ? parts.join("\n\n") : "No changes to the text or details.";
}

interface Part {
  heading: string;
  content: string;
}

/** Cuts `text` to at most `length` characters, at a line break when there is one. */
function cutText(text: string, length: number): string {
  if (length <= 0) return "";
  const end = text.lastIndexOf("\n", length);
  if (end > 0) return text.slice(0, end).trimEnd();
  const cut = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Joins headed parts into one Markdown text of at most 60,000 characters, cutting the parts at
 * `cutFirst` (in that order) and marking each cut with "…(cut)".
 */
function joinParts(parts: Part[], cutFirst: number[]): string {
  const render = () =>
    `${parts.map((part) => `${part.heading}\n\n${part.content}`).join("\n\n")}\n`;
  let text = render();
  for (const index of cutFirst) {
    const part = parts[index];
    if (text.length <= MAX_BODY || !part) break;
    const keep = part.content.length - (text.length - MAX_BODY) - (CUT.length + 2);
    const kept = cutText(part.content, keep);
    part.content = kept ? `${kept}\n\n${CUT}` : CUT;
    text = render();
  }
  return text;
}

/** The PR title (also the commit message) and body for a publish, an update or an unpublish. */
export function buildPullRequest(input: PullRequestInput): { title: string; body: string } {
  if (input.kind === "unpublish") {
    const isPrivate = input.isPrivate ?? notPrivate;
    const title = input.title?.trim() && !isPrivate(input.title) ? input.title : input.path;
    const rows: [string, string][] = [
      ["URL", urlOf(input.slug)],
      ["Created", isIsoDate(input.date) ? input.date : NONE],
      ...(isIsoDate(input.updated) ? [["Updated", input.updated] as [string, string]] : []),
      ["File", code(input.path)],
    ];
    const body = joinParts(
      [
        { heading: "## Overview", content: overviewTable(rows) },
        {
          heading: "## What changed",
          content: `Deletes ${code(input.path)}. ${UNPUBLISH_NOTE}`,
        },
        { heading: "## Review checklist", content: UNPUBLISH_CHECKLIST.join("\n") },
      ],
      [],
    );
    return { title: pullRequestTitle("unpublish", title), body };
  }

  const { post } = input;
  const changes =
    input.kind === "publish"
      ? newPostChanges(post)
      : updateChanges(input.previous, post, input.isPrivate ?? notPrivate);
  const body = joinParts(
    [
      { heading: "## Overview", content: postOverview(input.slug, input.path, post) },
      { heading: "## Images", content: imageBlocks(lintFigures(post.body).figures) },
      { heading: "## What changed", content: changes },
      { heading: "## Review checklist", content: POST_CHECKLIST.join("\n") },
    ],
    [2, 1],
  );
  return { title: pullRequestTitle(input.kind, post.title), body };
}

/** The comment a republish adds to its open PR: what changed since the previous publish. */
export function buildRepublishComment(
  previous: PostSnapshot,
  next: PostSnapshot,
  isPrivate: (text: string) => boolean = notPrivate,
): string {
  return joinParts(
    [
      {
        heading: "### What changed since the previous publish",
        content: updateChanges(previous, next, isPrivate),
      },
    ],
    [0],
  );
}
