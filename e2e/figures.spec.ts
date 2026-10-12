import { expect, test } from "@playwright/test";

// Image section layout (design doc §4.9.4). No post has a figure yet, so the test adds empty ones
// to a real post page: what's under test is the site CSS. Headless Chromium on Linux has classic
// scrollbars, so the page is narrower than the viewport there, which is where `vw` goes wrong.

const WIDE_MAX = 1100; // 68.75rem

for (const viewport of [360, 1280]) {
  test(`wide and full figures are centred on the page at ${viewport}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 800 });
    await page.goto("/blog");
    await page.goto((await page.locator('main a[href^="/blog/"]').first().getAttribute("href"))!);
    const layout = await page.evaluate(() => {
      const prose = document.querySelector("main .prose")!;
      const boxes: Record<string, { left: number; right: number }> = {};
      for (const size of ["column", "wide", "full"]) {
        const figure = document.createElement("figure");
        figure.className = `figure figure--${size}`;
        figure.style.height = "50px";
        prose.append(figure);
        const { left, right } = figure.getBoundingClientRect();
        boxes[size] = { left, right };
      }
      // The root's box, not clientWidth: with `scrollbar-gutter: stable` that includes the gutter.
      const root = document.documentElement;
      return {
        boxes,
        pageWidth: root.getBoundingClientRect().width,
        scrollWidth: root.scrollWidth,
      };
    });
    const { boxes, pageWidth } = layout;
    // Nothing sticks out sideways.
    expect(layout.scrollWidth).toBeLessThanOrEqual(pageWidth);

    expect(boxes.full!.left).toBeCloseTo(0, 0);
    expect(boxes.full!.right).toBeCloseTo(pageWidth, 0);
    const wide = Math.min(WIDE_MAX, pageWidth);
    expect(boxes.wide!.left).toBeCloseTo((pageWidth - wide) / 2, 0);
    expect(boxes.wide!.right).toBeCloseTo((pageWidth + wide) / 2, 0);
    // A column figure keeps to the text.
    expect(boxes.column!.left).toBeGreaterThan(0);
    expect(boxes.column!.right).toBeLessThan(pageWidth);
  });
}
