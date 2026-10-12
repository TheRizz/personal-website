import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WARN_RULES, writeStaticHeaders } from "./static-headers";

let clientDir: string;

beforeEach(async () => {
  clientDir = await mkdtemp(path.join(tmpdir(), "static-headers-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(clientDir, { recursive: true, force: true });
});

/** Writes `count` prerendered pages, each with its own inline script. */
async function writePages(count: number) {
  for (let page = 0; page < count; page++) {
    await writeFile(path.join(clientDir, `page-${page}.html`), `<script>window.p=${page}</script>`);
  }
}

describe("writeStaticHeaders", () => {
  it("writes the site-wide rule and one hash rule per page", async () => {
    await writePages(2);
    await writeStaticHeaders(clientDir);
    const headers = await readFile(path.join(clientDir, "_headers"), "utf8");
    expect(headers).toMatch(/^\/\*\n/);
    expect(headers).toContain("\n/page-0\n  ! Content-Security-Policy\n");
    expect(headers.match(/'sha256-/g)).toHaveLength(2);
  });

  it("warns well before the rule cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writePages(WARN_RULES - 1);
    await writeStaticHeaders(clientDir);
    expect(warn).not.toHaveBeenCalled();

    await writePages(WARN_RULES);
    await writeStaticHeaders(clientDir);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${WARN_RULES + 1} of 100 rules`));
  });

  it("fails the build over the cap of 100 rules", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writePages(100);
    await expect(writeStaticHeaders(clientDir)).rejects.toThrow(/101 rules, over the limit of 100/);
  });
});
