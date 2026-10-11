import { data, Link } from "react-router";
import { ReadingProgress } from "~/components/ReadingProgress";
import { formatLongDate } from "~/lib/dates";
import { pageMeta } from "~/lib/meta";
import { getPost } from "~/lib/posts.server";
import type { Route } from "./+types/blog.$slug";

export const meta: Route.MetaFunction = ({ loaderData, params }) =>
  loaderData
    ? pageMeta({
        title: loaderData.post.title,
        description: loaderData.post.summary,
        path: `/blog/${params.slug}`,
        type: "article",
      })
    : [{ title: "Post not found" }];

export function loader({ params }: Route.LoaderArgs) {
  const result = getPost(params.slug);
  if (!result) throw data(null, { status: 404 });
  return result;
}

export default function BlogPost({ loaderData: { post, newer, older } }: Route.ComponentProps) {
  return (
    <>
      <ReadingProgress />
      <article>
        <header className="mb-10 text-center">
          <h1 className="mb-3 text-4xl leading-tight font-extrabold tracking-[-0.03em] text-balance sm:text-5xl">
            {post.title}
          </h1>
          <p className="text-sm text-muted">
            <time dateTime={post.date}>{formatLongDate(post.date)}</time> • {post.readingMinutes}{" "}
            min read
          </p>
          {post.tags.length > 0 && (
            <ul aria-label="Tags" className="mt-4 flex flex-wrap justify-center gap-2">
              {post.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-line bg-surface px-2.5 text-xs leading-6 text-muted"
                >
                  #{tag}
                </li>
              ))}
            </ul>
          )}
        </header>

        {post.headings.length >= 2 && (
          <details open className="mb-10 border-l-2 border-fg pl-4 text-[0.9rem] leading-snug">
            <summary className="cursor-pointer font-bold">Contents</summary>
            <ol className="mt-3 space-y-2">
              {post.headings.map((heading) => (
                <li key={heading.id} className={heading.depth === 3 ? "pl-4" : undefined}>
                  <a href={`#${heading.id}`} className="text-muted hover:text-fg">
                    {heading.text}
                  </a>
                </li>
              ))}
            </ol>
          </details>
        )}

        {/* Trusted HTML: rendered and sanitized from our own Markdown at build time. */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />
      </article>

      {(newer || older) && (
        <nav
          aria-label="More posts"
          className="mt-16 grid gap-4 border-t border-line pt-8 sm:grid-cols-2"
        >
          {older && (
            <Link to={`/blog/${older.slug}`} className="group rounded-xl p-3 hover:bg-surface">
              <span className="block text-xs tracking-[0.08em] text-muted uppercase">Older</span>
              <span className="font-semibold group-hover:underline">{older.title}</span>
            </Link>
          )}
          {newer && (
            <Link
              to={`/blog/${newer.slug}`}
              className="group rounded-xl p-3 hover:bg-surface sm:col-start-2 sm:text-right"
            >
              <span className="block text-xs tracking-[0.08em] text-muted uppercase">Newer</span>
              <span className="font-semibold group-hover:underline">{newer.title}</span>
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
