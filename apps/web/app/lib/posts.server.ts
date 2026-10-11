import type { Post, PostSummary } from "@site/content-schema";
import posts from "~/generated/posts.json";

const all = posts as Post[];

const summarize = ({ html: _html, headings: _headings, ...summary }: Post): PostSummary => summary;

/** All published posts, newest first. */
export function listPosts(limit?: number): PostSummary[] {
  return all.slice(0, limit).map(summarize);
}

/** A post plus its neighbours: `newer` is the next post in time, `older` the previous. */
export function getPost(slug: string) {
  const index = all.findIndex((post) => post.slug === slug);
  if (index === -1) return undefined;
  const newer = all[index - 1];
  const older = all[index + 1];
  return {
    post: all[index]!,
    newer: newer && summarize(newer),
    older: older && summarize(older),
  };
}
