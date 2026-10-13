import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  CancelPublishDialog,
  ErrorMessage,
  PublishDialog,
  UnpublishDialog,
  restoreFocus,
} from "./PublishDialog";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

/** Renders inside a router, as the editor and /admin do (ErrorMessage links to a draft). */
function render(element: React.ReactElement) {
  const router = createMemoryRouter([{ path: "/", element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("PublishDialog", () => {
  it("shows the exposure warning word for word", () => {
    const html = render(
      <PublishDialog
        slug="hello"
        suggestedSlug="hello"
        busy={false}
        error={null}
        onConfirm={noop}
        onClose={noop}
      />,
    );
    expect(text(html)).toContain(
      "Publishing makes this text public on a GitHub pull request now. It goes live about a " +
        "minute after you merge that PR, and it stays in git history even if you cancel.",
    );
    expect(text(html)).toContain("Publish this post?");
    expect(text(html)).toContain("https://ry-mart.com/blog/hello");
    expect(html).toMatch(/<button[^>]*>Keep editing<\/button>/);
    expect(html).toMatch(/<button type="submit"[^>]*>Publish now<\/button>/);
    expect(html).not.toContain("Address");
  });

  it("asks for the address while the draft has none", () => {
    const html = render(
      <PublishDialog
        slug={null}
        suggestedSlug="my-first-post"
        busy={false}
        error={null}
        onConfirm={noop}
        onClose={noop}
      />,
    );
    const [, id] = /<label for="([^"]+)"[^>]*>Address<\/label>/.exec(html) ?? [];
    expect(id).toBeDefined();
    expect(html).toMatch(new RegExp(`<input[^>]*id="${id}"[^>]*value="my-first-post"`));
    expect(text(html)).toContain("https://ry-mart.com/blog/my-first-post");
  });

  it("refuses an address that isn't a slug", () => {
    const html = render(
      <PublishDialog
        slug={null}
        suggestedSlug="Not A Slug"
        busy={false}
        error={null}
        onConfirm={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Publish now<\/button>/);
  });
});

describe("the other dialogs", () => {
  it("asks before closing the pull request", () => {
    const html = render(
      <CancelPublishDialog
        pr={7}
        action="publish"
        busy={false}
        error={null}
        onConfirm={noop}
        onClose={noop}
      />,
    );
    expect(text(html)).toContain("Close the pull request?");
    expect(text(html)).toContain("PR #7");
    expect(html).toMatch(/>Close the PR<\/button>/);
    expect(html).toMatch(/>Keep it open<\/button>/);
  });

  it("warns what unpublishing can't take back", () => {
    const html = render(
      <UnpublishDialog
        path="content/blog/2026-10-11-hello-world.md"
        slug="hello-world"
        busy={false}
        error={null}
        onConfirm={noop}
        onClose={noop}
      />,
    );
    expect(text(html)).toContain(
      "Unpublishing opens a pull request that deletes content/blog/2026-10-11-hello-world.md. " +
        "The post leaves the site about a minute after you merge it, but it stays in public git " +
        "history. To take it down right now, block /blog/hello-world with a WAF rule. Its images " +
        "stay at photos.ry-mart.com; delete them in R2 and purge the cache if they must go too.",
    );
    expect(html).toMatch(/>Open the unpublish PR<\/button>/);
    expect(html).toMatch(/>Keep it published<\/button>/);
  });

  it("lists every error line and links the draft that holds an address", () => {
    const html = render(
      <ErrorMessage
        error={{ text: "Another draft uses this address.", lines: ["a", "b"], draftId: "d1" }}
      />,
    );
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).toMatch(/<a [^>]*href="\/admin\/drafts\/d1"[^>]*>Open that draft<\/a>/);
    expect(html).toContain("<li>a</li><li>b</li>");
  });
});

describe("restoreFocus", () => {
  const element = (isConnected: boolean) => {
    const focus = vi.fn();
    return { node: { isConnected, focus } as unknown as HTMLElement, focus };
  };

  it("goes back to the opener while it is on the page", () => {
    const opener = element(true);
    const fallback = element(true);
    restoreFocus(opener.node, fallback.node);
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(fallback.focus).not.toHaveBeenCalled();
  });

  it("goes to the fallback when the opener left the page with the dialog", () => {
    // Cancel publish: the closed PR takes the Cancel button away in the same render.
    const opener = element(false);
    const fallback = element(true);
    restoreFocus(opener.node, fallback.node);
    expect(opener.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledOnce();
    expect(() => restoreFocus(null, undefined)).not.toThrow();
  });
});
