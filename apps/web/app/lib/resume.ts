import data from "../../../../content/resume/resume.json";

// The resume's one source. The /resume page renders it, and `pnpm resume` (scripts/build-resume.ts)
// builds the PDF and Word downloads from the same file, so all three say the same thing.

export interface Resume {
  name: string;
  headline: string;
  location: string;
  availability: string;
  email: string;
  links: { label: string; url: string }[];
  summary: string;
  experience: {
    company: string;
    title: string;
    start: string;
    end: string;
    intro?: string;
    bullets: string[];
  }[];
  earlier: { company: string; title: string; start: string; end: string; line: string }[];
  projects: { name: string; url?: string; line: string }[];
  skills: { group: string; items: string[] }[];
  education: { school: string; degree: string; year: string };
}

export const resume: Resume = data;

/** Served from apps/web/public/resume/. */
export const RESUME_FILES = {
  pdf: "/resume/ryan-martinez-resume.pdf",
  docx: "/resume/ryan-martinez-resume.docx",
} as const;
