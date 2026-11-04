import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Renders Pipeline Tycoon's home-screen icon (apps/web/public/games/pipeline-tycoon/icon.svg) to
// the PNG sizes the web app manifest and iOS ask for. iOS ignores SVG touch icons, so the PNGs are
// committed; rerun this after changing the SVG. CHROMIUM_PATH points at a browser other than
// Playwright's own (e.g. /opt/pw-browsers/chromium).

const DIR = new URL("../apps/web/public/games/pipeline-tycoon/", import.meta.url);
/** 180: iPhone home screen (apple-touch-icon). 192 and 512: manifest, Android and installs. */
const SIZES = [180, 192, 512];

const svg = await readFile(new URL("icon.svg", DIR), "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await writeFile(
      new URL(`icon-${size}.png`, DIR),
      await page.screenshot({ omitBackground: false }),
    );
    await page.close();
    console.log(`icon-${size}.png`);
  }
} finally {
  await browser.close();
}
