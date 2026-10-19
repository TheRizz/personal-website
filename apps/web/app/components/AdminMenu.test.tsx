import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SECTIONS, AdminMenu } from "./AdminMenu";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminMenu", () => {
  it("renders nothing on the server, so prerendered pages have no admin markup", () => {
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("document", { cookie: "owner_hint=1" });
    const router = createMemoryRouter([{ path: "/", element: <AdminMenu /> }]);
    expect(renderToStaticMarkup(<RouterProvider router={router} />)).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("links each built section to a page under /admin", () => {
    for (const { href } of ADMIN_SECTIONS) {
      if (href) expect(href).toMatch(/^\/admin(\/|$)/);
    }
    expect(ADMIN_SECTIONS.map((section) => section.label)).toEqual([
      "Blog posts",
      "Photos",
      "Code snippets",
    ]);
  });
});
