import { Link } from "react-router";
import { formatShortDate, groupByYearAndMonth } from "~/lib/dates";
import type { PostSummary } from "@site/content-schema";

/** Posts grouped by year and month, newest first. */
export function PostTimeline({ posts }: { posts: PostSummary[] }) {
  if (posts.length === 0) {
    return <p className="text-muted">No posts yet. Check back soon.</p>;
  }

  return (
    <div className="space-y-14">
      {groupByYearAndMonth(posts).map(({ year, months }) => (
        <section key={year} aria-labelledby={`year-${year}`}>
          <h2
            id={`year-${year}`}
            className="mb-4 text-4xl leading-tight font-extrabold tracking-[-0.03em]"
          >
            {year}
          </h2>
          <div className="space-y-8">
            {months.map(({ month, items }) => (
              <div key={month}>
                <h3 className="mb-3 text-sm font-semibold tracking-[0.08em] text-muted uppercase">
                  {month}
                </h3>
                <ul className="flex flex-col gap-3">
                  {items.map((post) => (
                    <li key={post.slug}>
                      <Link
                        to={`/blog/${post.slug}`}
                        className="group -mx-4 block rounded-xl px-4 py-3.5 transition duration-200 ease-spring hover:bg-surface active:scale-[0.995]"
                      >
                        <h4 className="mb-1.5 text-xl leading-snug font-bold tracking-tight decoration-underline decoration-1 underline-offset-4 transition duration-200 ease-spring group-hover:translate-x-0.5 group-hover:underline">
                          {post.title}
                        </h4>
                        <p className="mb-2 text-[0.92rem] leading-relaxed text-muted">
                          {post.summary}
                        </p>
                        <p className="text-[0.8rem] tracking-[0.02em] text-muted">
                          {formatShortDate(post.date)} • {post.readingMinutes} min read
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
