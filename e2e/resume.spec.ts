import { expect } from "@playwright/test";
import { cspTest } from "./csp";
import { uniqueIp } from "./helpers";

// The Resume page and its two downloads, both built from content/resume/resume.json.

const test = cspTest({ headers: () => ({ "CF-Connecting-IP": uniqueIp() }), consoleErrors: true });

test("shows the resume and serves the PDF and Word downloads", async ({ page, request }) => {
  await page.goto("/resume");
  await expect(page.getByRole("heading", { level: 1, name: "Resume" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Glenair/ })).toBeVisible();

  const files = [
    { name: "Download PDF", type: "application/pdf", magic: "%PDF" },
    { name: "Download Word", type: "officedocument.wordprocessingml", magic: "PK" },
  ];
  for (const file of files) {
    const link = page.getByRole("link", { name: file.name });
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();
    expect(await link.getAttribute("download")).not.toBeNull();
    const response = await request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(file.type);
    expect((await response.body()).subarray(0, file.magic.length).toString("latin1")).toBe(
      file.magic,
    );
  }
});
