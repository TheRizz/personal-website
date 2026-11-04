import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resumeSourceHash } from "./resume-hash";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

describe("resume downloads", () => {
  it("were rebuilt after the last change to resume.json (run `pnpm resume`)", () => {
    const generated = JSON.parse(read("content/resume/generated.json"));
    expect(generated.sourceHash).toBe(resumeSourceHash(root));
  });

  // Keep in step with RESUME_FILES in app/lib/resume.ts.
  it.each(["pdf", "docx"])("the .%s file exists", (ext) => {
    expect(existsSync(`${root}apps/web/public/resume/ryan-martinez-resume.${ext}`)).toBe(true);
  });

  it("leaves the phone number out of the public resume", () => {
    expect(read("content/resume/resume.json")).not.toMatch(/\(?\d{3}\)?[ .-]\d{3}-\d{4}/);
  });
});
