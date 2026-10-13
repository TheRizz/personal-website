// The reading time shown on a post and in its pull request (design doc §4.9.7).

/** Reading speed the estimate assumes. */
export const WORDS_PER_MINUTE = 220;

/**
 * Minutes to read a post, at least 1. `content` is the Markdown after the frontmatter, exactly as
 * gray-matter returns it: the build has always counted that way, so `posts.json` doesn't change.
 */
export function readingMinutes(content: string): number {
  return Math.max(1, Math.round(content.split(/\s+/).length / WORDS_PER_MINUTE));
}
