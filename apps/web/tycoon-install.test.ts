import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pipeline Tycoon's home-screen install: the manifest and icons in public/ must agree with the
// route and with each other, or iOS and Android quietly fall back to a screenshot icon.

const DIR = new URL("./public/games/pipeline-tycoon/", import.meta.url);
const ROUTE = "/games/pipeline-tycoon";

interface Manifest {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", DIR), "utf8")) as Manifest;
const fileOf = (src: string) => new URL(`./public${src}`, new URL("./", import.meta.url));

describe("Pipeline Tycoon manifest", () => {
  it("opens the game full screen and stays inside it", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.id).toBe(ROUTE);
    expect(manifest.start_url).toBe(ROUTE);
    expect(manifest.scope).toBe(ROUTE);
  });

  it("uses the scene's background, which the icon is drawn on", () => {
    const svg = readFileSync(new URL("icon.svg", DIR), "utf8");
    const fill = /<rect width="512" height="512" fill="(#[0-9a-f]{6})"/.exec(svg)?.[1];
    expect(manifest.theme_color).toBe(fill);
    expect(manifest.background_color).toBe(fill);
  });

  it("lists icons that exist at the size they claim, a 512 maskable one included", () => {
    expect(manifest.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(
      true,
    );
    for (const icon of manifest.icons) {
      const file = readFileSync(fileOf(icon.src));
      if (icon.type !== "image/png") continue;
      expect(file.subarray(1, 4).toString(), icon.src).toBe("PNG");
      expect(`${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
    }
  });

  it("has the 180 px icon iPhones use for the home screen", () => {
    const png = readFileSync(new URL("icon-180.png", DIR));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
