import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { eyebrow, ghostButton } from "~/components/games/ui";
import { adminFetch, useSessionExpired } from "~/lib/admin/api";
import { clearOwnerHint, SIGN_OUT_PATH } from "~/lib/admin/owner-hint";
import { adminMeta } from "~/lib/meta";
import type { Route } from "./+types/admin";

// The admin area's layout (design doc §4.9.2). The Worker serves it only to the owner, and it
// has no server loader or action: every piece of data comes from /api/admin/* in the browser, so
// even the HTML shell holds nothing private.

export const meta: Route.MetaFunction = () => adminMeta("Admin");

/** The signed-in e-mail from GET /api/admin/me, which also sets the owner hint. */
function useOwnerEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    adminFetch("/api/admin/me", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { email?: unknown };
        if (typeof body.email === "string") setEmail(body.email);
      })
      .catch(() => {
        // Offline or aborted: the e-mail is only a label.
      });
    return () => controller.abort();
  }, []);
  return email;
}

export default function AdminLayout() {
  const email = useOwnerEmail();
  const sessionExpired = useSessionExpired();
  const { pathname } = useLocation();

  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface py-2 pr-2 pl-4">
        <div className="min-w-0 leading-snug sm:flex sm:items-baseline sm:gap-x-3">
          <p className={eyebrow}>Admin</p>
          {email && (
            // On a phone the e-mail sits under "Admin" and a long one is cut short.
            <p className="truncate text-sm text-muted" title={email}>
              <span className="sr-only sm:not-sr-only">Signed in as </span>
              {email}
            </p>
          )}
        </div>
        {/* A full page load: Access ends the session, then the hint for public pages goes too. */}
        <a href={SIGN_OUT_PATH} onClick={clearOwnerHint} className={`${ghostButton} shrink-0`}>
          <LogOut aria-hidden="true" />
          Sign out
        </a>
      </div>
      {sessionExpired && (
        <p
          role="alert"
          className="mb-8 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[0.95rem]"
        >
          {/* Reloading the page sends the browser through the Access login and back here. */}
          Session expired,{" "}
          <a href={pathname} className="link font-semibold">
            sign in again
          </a>
          .
        </p>
      )}
      <Outlet />
    </>
  );
}
