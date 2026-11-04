import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The files that shape the resume downloads, relative to the repo root. */
export const RESUME_SOURCES = ["content/resume/resume.json", "scripts/build-resume.ts"];

/**
 * Hash of everything that shapes the PDF and Word downloads. `pnpm resume` records it; a unit test
 * fails when it no longer matches, so the downloads can't drift from the page.
 */
export function resumeSourceHash(root: string): string {
  const h = createHash("sha256");
  for (const f of RESUME_SOURCES)
    h.update(readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n"));
  return h.digest("hex");
}
