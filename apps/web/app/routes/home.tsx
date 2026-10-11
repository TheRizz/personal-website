import { Link } from "react-router";
import { PostTimeline } from "~/components/PostTimeline";
import { pageMeta } from "~/lib/meta";
import { listPosts } from "~/lib/posts.server";
import { site } from "~/site";
import type { Route } from "./+types/home";

const LATEST_POSTS = 10;

export const meta: Route.MetaFunction = () => pageMeta({ path: "/" });

export function loader() {
  return { posts: listPosts(LATEST_POSTS), total: listPosts().length };
}

export default function Home({ loaderData: { posts, total } }: Route.ComponentProps) {
  return (
    <>
      <section className="mb-14">
        <h1 className="mb-3 text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">
          {site.intro.heading}
        </h1>
        <p className="text-body">{site.intro.body}</p>
      </section>
      <PostTimeline posts={posts} />
      {total > posts.length && (
        <p className="mt-10">
          <Link to="/blog" className="link">
            All {total} posts
          </Link>
        </p>
      )}
    </>
  );
}
