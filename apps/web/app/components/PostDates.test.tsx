import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostDates } from "./PostDates";

describe("PostDates", () => {
  it("shows only the created date for a post that was never updated", () => {
    expect(renderToStaticMarkup(<PostDates date="2026-10-11" />)).toBe(
      '<time dateTime="2026-10-11">October 11, 2026</time>',
    );
  });

  it("shows the created and the updated date", () => {
    expect(renderToStaticMarkup(<PostDates date="2026-10-11" updated="2026-11-02" />)).toBe(
      '<time dateTime="2026-10-11">October 11, 2026</time> • Updated ' +
        '<time dateTime="2026-11-02">November 2, 2026</time>',
    );
  });

  it("hides an updated date that is the same day", () => {
    expect(
      renderToStaticMarkup(<PostDates date="2026-10-11" updated="2026-10-11" />),
    ).not.toContain("Updated");
  });
});
