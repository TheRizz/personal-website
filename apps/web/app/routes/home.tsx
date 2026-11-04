import { Link } from "react-router";
import { CurrentProjects } from "~/components/CurrentProjects";
import { PostTimeline } from "~/components/PostTimeline";
import { pageMeta } from "~/lib/meta";
import { listPosts } from "~/lib/posts.server";
import type { Project } from "~/lib/projects";
import { listProjects } from "~/lib/projects.server";
import { site } from "~/site";
import type { Route } from "./+types/home";

// The home page. Rendered by the Worker on each request, not prerendered, so a project edited at
// /admin/projects shows without a deploy.

const LATEST_POSTS = 10;

export const meta: Route.MetaFunction = () => pageMeta({ path: "/" });

// Never kept by the browser, so an edit in /admin shows on the next visit. A render is one small
// D1 read.
export const headers: Route.HeadersFunction = () => ({
  "Cache-Control": "public, max-age=0, must-revalidate",
});

export async function loader({ context }: Route.LoaderArgs) {
  let projects: Project[] = [];
  try {
    projects = await listProjects(context.cloudflare.env.DB);
  } catch (error) {
    // The posts still show if the projects can't be read.
    console.error("Couldn't read projects", error);
  }
  return { projects, posts: listPosts(LATEST_POSTS), total: listPosts().length };
}

export default function Home({ loaderData: { projects, posts, total } }: Route.ComponentProps) {
  return (
    <>
      <section className="mb-14">
        <h1 className="mb-3 text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">
          {site.intro.heading}
        </h1>
        <p className="text-body">{site.intro.body}</p>
      </section>
      <CurrentProjects projects={projects} />
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
