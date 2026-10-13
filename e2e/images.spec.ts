import { crc32, deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";

// Image sections in the draft editor (design doc §4.9.6, Step 10.6): upload, alt text, moving
// and the caption, signed in with the localhost-only test identity standing in for Access.

const test = cspTest({
  headers: async () => ({ [ASSERTION_HEADER]: await signAccessToken() }),
  consoleErrors: true,
});

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A small opaque RGB PNG with a gradient, built here so the test needs no binary fixture. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB; compression, filter and interlace stay 0
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Each row starts with filter type 0 (none).
      rows.set([40 * x, 60 * y, 200], y * stride + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const IMAGE = png(6, 4);

/** GET /api/admin/... from the page, as the owner. */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
    return (await response.json()) as T;
  }, path);
}

async function discard(page: Page, id: string) {
  await page.evaluate(async (url) => {
    await fetch(url, { method: "DELETE", headers: { "X-Admin": "1" } });
  }, `/api/admin/drafts/${id}`);
}

/** Picks `file` through the toolbar's Image button and returns the "Add an image" dialog. */
async function pickImage(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await (await chooser).setFiles(file);
  const dialog = page.getByRole("dialog", { name: "Add an image" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the owner adds an image, moves it above a paragraph and captions it", async ({ page }) => {
  // Local uploads go to local R2, not the photos CDN, so the preview's requests for it get the
  // test image instead and nothing leaves the machine.
  await page.route("https://photos.ry-mart.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: IMAGE }),
  );
  await page.goto("/admin");
  await page.getByRole("button", { name: "New post" }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").at(-1)!;

  try {
    await page.getByLabel("Title").fill("E2E image post");
    const body = page.getByRole("textbox", { name: "Post body" });
    await body.click();
    await page.keyboard.type("A paragraph before the image.");

    // An SVG is refused in the browser, before anything is uploaded.
    const refused = await pickImage(page, {
      name: "drawing.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'),
    });
    await expect(refused.getByRole("alert")).toContainText("SVG");
    await refused.getByRole("button", { name: "Cancel" }).click();
    await expect(refused).toBeHidden();

    const dialog = await pickImage(page, {
      name: "photo.png",
      mimeType: "image/png",
      buffer: IMAGE,
    });
    const insert = dialog.getByRole("button", { name: "Insert" });
    // Alt text is required, even once the upload is done.
    await expect(dialog.getByRole("status")).toHaveText("Uploaded.", { timeout: 15_000 });
    await expect(insert).toBeDisabled();
    await dialog.getByLabel("Alt text").fill("   ");
    await expect(insert).toBeDisabled();
    await dialog.getByLabel("Alt text").fill("A test pattern");
    await expect(insert).toBeEnabled();
    await insert.click();
    await expect(dialog).toBeHidden();

    // The new figure shows the uploaded file from this tab, re-encoded at its own size.
    const figure = body.locator("figure");
    const image = figure.getByRole("img", { name: "A test pattern" });
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect(image).toHaveJSProperty("naturalWidth", 6);
    await expect(figure.getByLabel("Alt text")).toHaveValue("A test pattern");

    const blocks = body.locator(":scope > *");
    await expect(blocks.first()).toHaveText("A paragraph before the image.");
    await figure.getByRole("button", { name: "Move up" }).click();
    await expect(blocks.first().locator("figure")).toHaveCount(1);

    await figure.locator("figcaption").click();
    await page.keyboard.type("A caption");
    // The keyboard moves it too, with the caret still in the caption.
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await expect(blocks.first()).toHaveText("A paragraph before the image.");
    await page.keyboard.press("Alt+Shift+ArrowUp");
    await expect(blocks.first().locator("figure")).toHaveCount(1);
    await page.keyboard.type(".");

    const markdown =
      /^::figure\[A caption\.\]\{src="blog\/[0-9a-f-]{36}\.webp" alt="A test pattern" size="column" w="6" h="4"\}\n\nA paragraph before the image\.\n$/;
    await expect
      .poll(
        async () => (await apiGet<{ bodyMd: string }>(page, `/api/admin/drafts/${id}`)).bodyMd,
        {
          timeout: 15_000,
        },
      )
      .toMatch(markdown);

    const preview = page.getByRole("article", { name: "Preview" });
    await expect(preview.locator(".prose > *").first()).toHaveClass(/\bfigure\b/);
    await expect(preview.locator("figure img")).toHaveAttribute("alt", "A test pattern");
    await expect(preview.locator("figure img")).toHaveAttribute(
      "src",
      /^https:\/\/photos\.ry-mart\.com\/blog\/[0-9a-f-]{36}-6\.webp$/,
    );
    await expect(preview.locator("figure figcaption")).toHaveText("A caption.");

    // The heading button can't turn the figure into a heading and lose the image.
    await body.locator("figcaption").click();
    await page.getByRole("button", { name: "Heading 2" }).click();
    await expect(body.locator("figure")).toHaveCount(1);
    await expect(body.locator("h2")).toHaveCount(0);

    await page.getByRole("tab", { name: "Raw Markdown" }).click();
    await expect(page.getByLabel("Post body (Markdown)")).toHaveValue(markdown);
  } finally {
    await discard(page, id);
  }
});
