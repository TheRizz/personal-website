import { describe, expect, it } from "vitest";
import { figureUrls, figureWidths, parseFigure, variantKey } from "./figure";

const KEY = "blog/2b1f6c1e-8a0d-4c55-9e1a-3f2d4c5b6a7e";

describe("figure variants", () => {
  it.each([
    [2048, [480, 1024, 2048]],
    [1600, [480, 1024, 1600]],
    [1024, [480, 1024]],
    [600, [480, 600]],
    [480, [480]],
    [300, [300]],
  ])("stores w=%i at %j", (w, widths) => {
    expect(figureWidths(`${KEY}.webp`, w)).toEqual(widths);
  });

  it("stores a GIF once, without a width suffix", () => {
    expect(figureWidths(`${KEY}.gif`, 2048)).toEqual([2048]);
    expect(variantKey(`${KEY}.gif`, 2048)).toBe(`${KEY}.gif`);
    expect(variantKey(`${KEY}.jpg`, 480)).toBe(`${KEY}-480.jpg`);
  });

  it("lists the public URL of every variant", () => {
    const { figure } = parseFigure("figure", { src: `${KEY}.png`, alt: "A", w: "800", h: "600" });
    expect(figure && figureUrls(figure)).toEqual([
      `https://photos.ry-mart.com/${KEY}-480.png`,
      `https://photos.ry-mart.com/${KEY}-800.png`,
    ]);
  });

  it("defaults size to column", () => {
    expect(parseFigure("figure", { src: `${KEY}.webp`, alt: "A", w: "1", h: "1" })).toEqual({
      figure: { src: `${KEY}.webp`, alt: "A", size: "column", w: 1, h: 1 },
    });
  });
});
