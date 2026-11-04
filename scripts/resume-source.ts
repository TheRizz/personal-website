import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Resume {
  name: string;
  headline: string;
  location: string;
  availability: string;
  email: string;
  links: { label: string; url: string }[];
  summary: string;
  experience: { company: string; title: string; start: string; end: string; intro?: string; bullets: string[] }[];
  earlier: { company: string; title: string; start: string; end: string; line: string }[];
  projects: { name: string; url?: string; line: string }[];
  skills: { group: string; items: string[] }[];
  education: { school: string; degree: string; year: string };
}

/** Hash of everything that shapes the downloads: the content and the script that renders it. */
export function resumeSourceHash(root: string): string {
  const h = createHash("sha256");
  for (const f of ["content/resume/resume.json", "scripts/build-resume.ts"]) {
    h.update(readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
}
