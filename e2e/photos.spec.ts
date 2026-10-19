import { crc32, deflateSync } from "node:zlib";
import { expect } from "@playwright/test";
import { ASSERTION_HEADER, signAccessToken } from "./access";
import { cspTest } from "./csp";

// The Photos page: the owner uploads a photo with a caption at /admin/photos, and /photos shows
// it with the caption underneath. Signed in with the localhost-only test identity.

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

test("the owner uploads a captioned photo and it shows on /photos", async ({ page }) => {
  // Local uploads go to local R2, not the photos CDN, so requests for it get the test image.
  await page.route("https://photos.ry-mart.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: IMAGE }),
  );
  const caption = `Sunset from the ridge ${Date.now()}`;
  await page.goto("/admin");
  await page.getByRole("link", { name: "Manage photos" }).click();
  await expect(page).toHaveURL(/\/admin\/photos$/);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add photo" }).click();
  await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: IMAGE });
  const form = page.getByRole("region", { name: "New photo" });
  await form.getByLabel("Caption (optional)").fill(caption);
  await form.getByRole("button", { name: "Save photo" }).click();
  await expect(form).toBeHidden();

  const item = page.getByRole("list", { name: "Your photos" }).getByRole("listitem").first();
  await expect(item.getByLabel("Caption (optional)")).toHaveValue(caption);

  await page.goto("/photos");
  const figure = page.locator("figure").filter({ hasText: caption });
  await expect(figure.locator("figcaption")).toHaveText(caption);
  await expect(figure.locator("img")).toHaveAttribute("alt", caption);
  await expect(figure.locator("img")).toHaveAttribute(
    "src",
    /^https:\/\/photos\.ry-mart\.com\/photos\/[0-9a-f-]{36}-6\.webp$/,
  );

  // Deleting it takes it off the page. The newest photo is listed first.
  await page.goto("/admin/photos");
  const own = page.getByRole("list", { name: "Your photos" }).getByRole("listitem").first();
  await expect(own.getByLabel("Caption (optional)")).toHaveValue(caption);
  page.once("dialog", (dialog) => void dialog.accept());
  const deleted = page.waitForResponse(
    (response) => response.request().method() === "DELETE" && response.status() === 204,
  );
  await own.getByRole("button", { name: "Delete" }).click();
  await deleted;
  await page.goto("/photos");
  await expect(page.locator("figure").filter({ hasText: caption })).toHaveCount(0);
});
