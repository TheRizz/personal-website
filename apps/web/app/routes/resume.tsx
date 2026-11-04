import { Download, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeading } from "~/components/PageHeading";
import { pageMeta } from "~/lib/meta";
import { RESUME_FILES, resume } from "~/lib/resume";
import type { Route } from "./+types/resume";

// The Resume page, prerendered from content/resume/resume.json. The PDF and Word downloads are
// built from the same file by `pnpm resume`.

const DESCRIPTION = `${resume.headline} in ${resume.location}. Work history, projects and skills.`;

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Resume", description: DESCRIPTION, path: "/resume" });

const dates = (e: { start: string; end: string }) => `${e.start} – ${e.end}`;

export default function ResumePage() {
  return (
    <>
      <PageHeading title="Resume">
        {resume.headline}. {resume.availability}.
      </PageHeading>

      <div className="mb-12 grid grid-cols-2 gap-3 sm:flex">
        <DownloadLink href={RESUME_FILES.pdf} label="PDF" primary />
        <DownloadLink href={RESUME_FILES.docx} label="Word" />
      </div>

      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-muted">
        <li>{resume.location}</li>
        <li className="min-w-0 break-all">
          <a href={`mailto:${resume.email}`} className="link">
            {resume.email}
          </a>
        </li>
        {resume.links
          .filter((l) => !l.url.startsWith("https://ry-mart.com"))
          .map((l) => (
            <li key={l.url}>
              <a href={l.url} className="link" rel="me">
                {l.label}
              </a>
            </li>
          ))}
      </ul>
      <p className="mb-12 max-w-[68ch] text-body">{resume.summary}</p>

      <Section title="Experience">
        <ol className="space-y-10">
          {resume.experience.map((job) => (
            <li key={job.company}>
              <RoleHeader company={job.company} title={job.title} when={dates(job)} />
              {job.intro && <p className="mt-2 max-w-[68ch] text-muted">{job.intro}</p>}
              <ul className="mt-3 max-w-[68ch] list-disc space-y-2 pl-5 text-body marker:text-muted">
                {job.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </li>
          ))}
          {resume.earlier.map((job) => (
            <li key={job.company}>
              <RoleHeader company={job.company} title={job.title} when={dates(job)} />
              <p className="mt-1 text-muted">{job.line}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Projects">
        <ul className="space-y-5">
          {resume.projects.map((p) => (
            <li key={p.name} className="max-w-[68ch]">
              <h3 className="font-semibold text-fg">
                {p.url ? (
                  <a href={p.url} className="link">
                    {p.name}
                  </a>
                ) : (
                  p.name
                )}
              </h3>
              <p className="mt-1 text-body">{p.line}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Skills">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-[10rem_1fr]">
          {resume.skills.map((s) => (
            <div key={s.group} className="contents">
              <dt className="font-semibold text-fg">{s.group}</dt>
              <dd className="mb-2 text-body sm:mb-0">{s.items.join(", ")}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Education">
        <RoleHeader
          company={resume.education.school}
          title={resume.education.degree}
          when={resume.education.year}
        />
      </Section>
    </>
  );
}

function DownloadLink({
  href,
  label,
  primary = false,
}: {
  href: string;
  label: string;
  primary?: boolean;
}) {
  const Icon = primary ? Download : FileText;
  return (
    <a
      href={href}
      download
      className={
        primary
          ? "inline-flex items-center justify-center gap-2 rounded-full bg-fg px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-85"
          : "inline-flex items-center justify-center gap-2 rounded-full border border-line px-5 py-2.5 font-semibold text-fg transition-colors hover:bg-surface-hover"
      }
    >
      <Icon aria-hidden className="size-4" />
      <span>
        <span className="max-sm:sr-only">Download </span>
        {label}
      </span>
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-14">
      <h2 className="mb-6 border-b border-line pb-2 text-sm font-bold uppercase tracking-[0.12em] text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function RoleHeader({ company, title, when }: { company: string; title: string; when: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <h3 className="text-lg font-semibold text-fg">
        {company} <span className="font-normal text-muted">· {title}</span>
      </h3>
      <span className="shrink-0 text-sm text-muted tabular-nums">{when}</span>
    </div>
  );
}
