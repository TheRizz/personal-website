import { PageHeading } from "~/components/PageHeading";
import { pageMeta } from "~/lib/meta";
import { photoAlt, photoImage, photoUrl, type Photo } from "~/lib/photos";
import { listPhotos } from "~/lib/photos.server";
import type { Route } from "./+types/photos";

// The Photos page. Unlike the other content pages it isn't prerendered: the Worker renders it from
// D1 on each request, so a photo uploaded from /admin shows at once. The caption is plain text.

const DESCRIPTION = "Photos I've taken.";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Photos", description: DESCRIPTION, path: "/photos" });

// Short, so an edit or a delete in /admin reaches visitors within a minute.
export const headers: Route.HeadersFunction = () => ({
  "Cache-Control": "public, max-age=60",
});

export async function loader({ context }: Route.LoaderArgs) {
  return { photos: await listPhotos(context.cloudflare.env.DB) };
}

/** Column widths at each breakpoint, matching the grid below (1, 2, then 3 columns). */
const SIZES = "(min-width: 68.75rem) 22rem, (min-width: 40rem) calc(50vw - 2.5rem), 100vw";

export default function Photos({ loaderData: { photos } }: Route.ComponentProps) {
  return (
    <>
      <PageHeading title="Photos">{DESCRIPTION}</PageHeading>
      {photos.length === 0 ? (
        <p className="text-muted">No photos yet.</p>
      ) : (
        <ul className="columns-1 gap-6 sm:columns-2 lg:columns-3">
          {photos.map((photo, index) => (
            <li key={photo.id} className="mb-6 break-inside-avoid">
              <PhotoFigure photo={photo} eager={index < 2} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PhotoFigure({ photo, eager }: { photo: Photo; eager: boolean }) {
  const { src, srcSet } = photoImage(photo);
  return (
    <figure>
      {/* Opens the largest variant, so a phone can zoom in on it. */}
      <a href={photoUrl(photo, photo.width)} className="block overflow-hidden rounded-xl">
        <img
          src={src}
          srcSet={srcSet}
          sizes={srcSet ? SIZES : undefined}
          width={photo.width}
          height={photo.height}
          alt={photoAlt(photo)}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          className="h-auto w-full bg-surface"
        />
      </a>
      {photo.caption && (
        <figcaption className="mt-2 text-[0.95rem] text-muted">{photo.caption}</figcaption>
      )}
    </figure>
  );
}
