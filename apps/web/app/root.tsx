import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import { BackToTop } from "./components/BackToTop";
import { PageHeading } from "./components/PageHeading";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { THEME_COLORS, themeScript } from "./components/ThemeToggle";
import "./app.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    // The theme script sets data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={THEME_COLORS.dark} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>
        <a
          href="#main-content"
          className="fixed top-[-100px] left-4 z-[100] rounded bg-fg px-4 py-2 font-bold text-bg transition-[top] focus:top-4"
        >
          Skip to content
        </a>
        <div className="mx-auto w-full max-w-[72ch] px-6 pt-9">
          <SiteHeader />
          <main id="main-content">{children}</main>
          <SiteFooter />
        </div>
        <BackToTop />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let details = "An unexpected error occurred. Try reloading the page.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error) && error.status === 404) {
    title = "Page not found";
    details = "There's nothing at this address. It may have moved, or the link may be wrong.";
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <>
      <title>{title}</title>
      <PageHeading title={title}>{details}</PageHeading>
      <a href="/" className="link">
        Go to the home page
      </a>
      {stack && (
        <pre className="mt-8 overflow-x-auto rounded-xl border border-line p-4 font-mono text-sm">
          <code>{stack}</code>
        </pre>
      )}
    </>
  );
}
