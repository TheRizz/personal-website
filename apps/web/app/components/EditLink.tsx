import { useEffect, useState } from "react";
import { hasOwnerHint } from "~/lib/admin/owner-hint";

// The Edit link on public posts (design doc §4.9.1). It renders nothing on the server and on the
// first client render, so prerendered HTML has no admin markup; a probe in the browser decides.
// Only a browser with the owner hint asks, and it asks with HEAD, so the owner's e-mail never
// reaches a public page, where the analytics beacon runs too. Don't import ~/lib/admin/api here:
// `pnpm check:bundle` fails if adminFetch reaches a public page.

const ME = "/api/admin/me";

/**
 * True when this browser is signed in as the owner. Without the hint in `cookie` it makes no
 * request at all; with it, one HEAD to /api/admin/me that must answer 200. A redirect to the
 * Access login (opaque, since redirects aren't followed), a refusal from the gate, a network
 * error or an abort all mean no, and none of them throws or logs.
 */
export async function probeOwner(cookie: string, signal?: AbortSignal): Promise<boolean> {
  if (!hasOwnerHint(cookie)) return false;
  try {
    const response = await fetch(ME, {
      method: "HEAD",
      redirect: "manual",
      credentials: "same-origin",
      cache: "no-store",
      // Access answers an expired session with 401 instead of a redirect to its login page.
      headers: { "X-Requested-With": "XMLHttpRequest" },
      signal,
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** "Edit" on a published post, linking to its draft, for the signed-in owner only. */
export function EditLink({ slug }: { slug: string }) {
  const [owner, setOwner] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void probeOwner(document.cookie, controller.signal).then((yes) => {
      if (!controller.signal.aborted) setOwner(yes);
    });
    return () => controller.abort();
  }, []);

  if (!owner) return null;
  return (
    <p className="mt-2 text-sm">
      {/* A plain link is a full page load: the Worker serves admin pages behind Access, with
          their own CSP. */}
      <a href={`/admin/posts/${slug}`} className="link">
        Edit
      </a>
    </p>
  );
}
