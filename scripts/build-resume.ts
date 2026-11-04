/**
 * Builds the downloadable resume (PDF and Word) from content/resume/resume.json, the same file the
 * /resume page renders, so the page and both downloads always say the same thing.
 *
 *   pnpm resume
 *
 * Writes apps/web/public/resume/ryan-martinez-resume.{pdf,docx} and records a hash of the source
 * in content/resume/generated.json. A unit test fails when resume.json (or this script) changes
 * without the files being rebuilt.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  LevelFormat,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";
import { chromium } from "@playwright/test";
import { resumeSourceHash } from "../apps/web/resume-hash";
import type { Resume } from "../apps/web/app/lib/resume";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "apps/web/public/resume");
export const FILE_BASE = "ryan-martinez-resume";

const resume = JSON.parse(readFileSync(join(root, "content/resume/resume.json"), "utf8")) as Resume;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dates = (e: { start: string; end: string }) => `${e.start} – ${e.end}`;

// ---------- PDF: print HTML rendered by Chromium ----------

function font(weight: number): string {
  const require = createRequire(join(root, "apps/web/package.json"));
  const file = require.resolve(
    `@fontsource/geist-sans/files/geist-sans-latin-${weight}-normal.woff2`,
  );
  const data = readFileSync(file).toString("base64");
  return `@font-face{font-family:Geist;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}

function html(r: Resume): string {
  const contact = [
    esc(r.location),
    `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`,
    ...r.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`),
  ].join('<span class="dot">·</span>');
  const job = (e: Resume["experience"][number]) => `
    <div class="role">
      <div class="row"><span><b>${esc(e.company)}</b> <span class="title">${esc(e.title)}</span></span><span class="date">${dates(e)}</span></div>
      ${e.intro ? `<p class="intro">${esc(e.intro)}</p>` : ""}
      <ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.name)} resume</title><style>
  ${[400, 500, 600, 700].map(font).join("\n")}
  @page{size:Letter;margin:0.42in 0.5in}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Geist,sans-serif;font-size:9pt;line-height:1.3;color:#27272a}
  a{color:inherit;text-decoration:none}
  h1{font-size:21pt;font-weight:700;letter-spacing:-0.02em;color:#18181b;line-height:1.1}
  .headline{font-size:11pt;font-weight:500;color:#0e7490;margin-top:2pt}
  .contact{margin-top:5pt;color:#52525b;font-size:8.8pt}
  .dot{margin:0 5pt;color:#a1a1aa}
  h2{font-size:8.4pt;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#18181b;border-bottom:0.75pt solid #d4d4d8;padding-bottom:2pt;margin:8pt 0 4pt;break-after:avoid}
  .summary{color:#3f3f46}
  .role{margin-bottom:5pt}
  .row{display:flex;justify-content:space-between;gap:12pt;align-items:baseline}
  .row b{font-weight:600;color:#18181b}
  .title{color:#3f3f46}
  .date{color:#71717a;font-size:8.6pt;white-space:nowrap;font-variant-numeric:tabular-nums}
  .intro{margin-top:2pt;color:#52525b}
  ul{margin:2pt 0 0 12pt}
  li{margin-top:1.2pt;padding-left:2pt}
  li::marker{color:#a1a1aa}
  .compact{margin-top:3pt}
  .compact .row{margin-top:2pt}
  .skills{display:grid;grid-template-columns:auto 1fr;column-gap:10pt;row-gap:1pt}
  .skills dt{font-weight:600;color:#18181b}
  </style></head><body>
  <h1>${esc(r.name)}</h1>
  <div class="headline">${esc(r.headline)} · ${esc(r.availability)}</div>
  <div class="contact">${contact}</div>
  <h2>Summary</h2><p class="summary">${esc(r.summary)}</p>
  <h2>Experience</h2>${r.experience.map(job).join("")}
  <div class="compact">${r.earlier
    .map(
      (e) =>
        `<div class="row"><span><b>${esc(e.company)}</b> <span class="title">${esc(e.title)}</span> <span class="intro">· ${esc(e.line)}</span></span><span class="date">${dates(e)}</span></div>`,
    )
    .join("")}</div>
  <h2>Projects</h2><ul>${r.projects
    .map(
      (p) =>
        `<li><b>${p.url ? `<a href="${esc(p.url)}">${esc(p.name)}</a>` : esc(p.name)}</b>: ${esc(p.line)}</li>`,
    )
    .join("")}</ul>
  <h2>Skills</h2><dl class="skills">${r.skills
    .map((s) => `<dt>${esc(s.group)}</dt><dd>${esc(s.items.join(", "))}</dd>`)
    .join("")}</dl>
  <h2>Education</h2>
  <div class="row"><span><b>${esc(r.education.school)}</b> <span class="title">${esc(r.education.degree)}</span></span><span class="date">${esc(r.education.year)}</span></div>
  </body></html>`;
}

async function pdf(r: Resume): Promise<Buffer> {
  const executablePath = process.env.RESUME_CHROMIUM || undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    await page.setContent(html(r), { waitUntil: "load" });
    await page.evaluate("document.fonts.ready");
    const out = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
    });
    const pages = out.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    if (pages > 1)
      console.warn(`Warning: the PDF runs to ${pages} pages; trim resume.json to fit one.`);
    return out;
  } finally {
    await browser.close();
  }
}

// ---------- DOCX ----------

const INK = "18181B";
const BODY = "27272A";
const MUTED = "52525B";
const ACCENT = "0E7490";
const PT = 2; // docx sizes are half-points
const RIGHT_TAB = 10_440; // twips: 8.5in page minus margins

const run = (
  text: string,
  o: { bold?: boolean; color?: string; size?: number; italics?: boolean } = {},
) =>
  new TextRun({
    text,
    bold: o.bold,
    italics: o.italics,
    color: o.color ?? BODY,
    size: (o.size ?? 10) * PT,
    font: "Calibri",
  });

const heading = (text: string) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D4D4D8", space: 2 } },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        color: INK,
        size: 9.5 * PT,
        font: "Calibri",
        characterSpacing: 20,
      }),
    ],
  });

const roleLine = (company: string, title: string, when: string, extra?: string) =>
  new Paragraph({
    spacing: { before: 100, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
    children: [
      run(company, { bold: true, color: INK }),
      run(`  ${title}`, { color: MUTED }),
      ...(extra ? [run(` · ${extra}`, { color: MUTED, size: 9.5 })] : []),
      run(`\t${when}`, { color: MUTED, size: 9.5 }),
    ],
  });

const bullet = (children: (TextRun | ExternalHyperlink)[]) =>
  new Paragraph({ numbering: { reference: "dots", level: 0 }, spacing: { after: 30 }, children });

const link = (text: string, url: string, o: Parameters<typeof run>[1] = {}) =>
  new ExternalHyperlink({ link: url, children: [run(text, o)] });

async function docx(r: Resume): Promise<Buffer> {
  const contact: (TextRun | ExternalHyperlink)[] = [run(r.location, { color: MUTED, size: 9.5 })];
  const dot = () => run("  ·  ", { color: "A1A1AA", size: 9.5 });
  contact.push(dot(), link(r.email, `mailto:${r.email}`, { color: MUTED, size: 9.5 }));
  for (const l of r.links) contact.push(dot(), link(l.label, l.url, { color: MUTED, size: 9.5 }));

  const doc = new Document({
    creator: r.name,
    title: `${r.name} resume`,
    numbering: {
      config: [
        {
          reference: "dots",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 300, hanging: 200 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12_240, height: 15_840 },
            margin: { top: 720, bottom: 720, left: 792, right: 792 },
          },
        },
        children: [
          new Paragraph({ children: [run(r.name, { bold: true, color: INK, size: 22 })] }),
          new Paragraph({
            children: [run(`${r.headline} · ${r.availability}`, { color: ACCENT, size: 11.5 })],
          }),
          new Paragraph({ spacing: { before: 60 }, children: contact }),
          heading("Summary"),
          new Paragraph({ children: [run(r.summary)] }),
          heading("Experience"),
          ...r.experience.flatMap((e) => [
            roleLine(e.company, e.title, dates(e)),
            ...(e.intro
              ? [
                  new Paragraph({
                    spacing: { after: 30 },
                    children: [run(e.intro, { color: MUTED })],
                  }),
                ]
              : []),
            ...e.bullets.map((b) => bullet([run(b)])),
          ]),
          ...r.earlier.map((e) => roleLine(e.company, e.title, dates(e), e.line)),
          heading("Projects"),
          ...r.projects.map((p) =>
            bullet([
              p.url
                ? link(p.name, p.url, { bold: true, color: INK })
                : run(p.name, { bold: true, color: INK }),
              run(`: ${p.line}`),
            ]),
          ),
          heading("Skills"),
          ...r.skills.map(
            (s) =>
              new Paragraph({
                spacing: { after: 20 },
                children: [
                  run(`${s.group}: `, { bold: true, color: INK }),
                  run(s.items.join(", ")),
                ],
              }),
          ),
          heading("Education"),
          roleLine(r.education.school, r.education.degree, r.education.year),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ---------- main ----------

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${FILE_BASE}.pdf`), await pdf(resume));
writeFileSync(join(outDir, `${FILE_BASE}.docx`), await docx(resume));
writeFileSync(
  join(root, "content/resume/generated.json"),
  `${JSON.stringify({ note: "Written by `pnpm resume`. Do not edit.", sourceHash: resumeSourceHash(root) }, null, 2)}\n`,
);
console.log(`Wrote ${FILE_BASE}.pdf and ${FILE_BASE}.docx to apps/web/public/resume/`);

// For a quick look at the print layout: RESUME_HTML=/some/file.html pnpm resume
if (process.env.RESUME_HTML) writeFileSync(process.env.RESUME_HTML, html(resume));
