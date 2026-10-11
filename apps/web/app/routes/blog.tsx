import { PageHeading } from "~/components/PageHeading";
import { PostTimeline } from "~/components/PostTimeline";
import { pageMeta } from "~/lib/meta";
import { listPosts } from "~/lib/posts.server";
import type { Route } from "./+types/blog";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Blog", description: "Long-form writing and build logs.", path: "/blog" });

export function loader() {
  return { posts: listPosts() };
}

export default function Blog({ loaderData: { posts } }: Route.ComponentProps) {
  return (
    <>
      <PageHeading title="Blog">Long-form writing and build logs.</PageHeading>
      <PostTimeline posts={posts} />
    </>
  );
}
