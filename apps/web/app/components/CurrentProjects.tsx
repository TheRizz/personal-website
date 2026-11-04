import { ArrowUpRight, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { groupProjects, type Project } from "~/lib/projects";

// The home page's current projects: priority 1, 2 and 3 large, every other active project in a
// short list, and the backlog folded away until tapped. Edited at /admin/projects. Renders nothing
// when there are no projects at all.

export function CurrentProjects({ projects }: { projects: readonly Project[] }) {
  const { featured, others, backlog } = groupProjects(projects);
  if (projects.length === 0) return null;
  const [lead, ...rest] = featured;
  return (
    <section aria-labelledby="projects-heading" className="mb-16">
      <h2
        id="projects-heading"
        className="mb-6 text-3xl leading-tight font-extrabold tracking-[-0.03em]"
      >
        What I&apos;m working on
      </h2>
      {lead && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FeaturedProject project={lead} lead />
          {rest.map((project) => (
            <FeaturedProject key={project.id} project={project} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className={lead ? "mt-10" : undefined}>
          {lead && <h3 className="mb-2 text-lg font-bold tracking-tight">Also in progress</h3>}
          <ul aria-label="Other projects" className="flex flex-col">
            {others.map((project) => (
              <li key={project.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <ProjectTitle project={project} className="text-[1.05rem] font-semibold" />
                  {project.progress !== null && <ProgressBar project={project} compact />}
                </div>
                {(project.summary || project.note) && (
                  <p className="mt-1 text-[0.92rem] leading-relaxed text-muted">
                    {[project.note, project.summary].filter(Boolean).join(". ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {backlog.length > 0 && (
        <details className="group mt-6 rounded-xl bg-surface">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-3 text-[1.05rem] font-semibold transition-colors hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
            <span>
              Backlog <span className="font-normal text-muted">({backlog.length})</span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-5 text-muted transition-transform duration-200 group-open:rotate-180"
            />
          </summary>
          <ul aria-label="Backlog" className="flex flex-col gap-4 px-5 pt-1 pb-5">
            {backlog.map((project) => (
              <li key={project.id}>
                <ProjectTitle project={project} className="font-semibold" />
                {project.summary && (
                  <p className="mt-0.5 text-[0.92rem] leading-relaxed text-muted">
                    {project.summary}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function FeaturedProject({ project, lead = false }: { project: Project; lead?: boolean }) {
  return (
    <article
      aria-label={project.title}
      className={`flex flex-col rounded-2xl bg-surface p-5 sm:p-6 ${lead ? "sm:col-span-2" : ""}`}
    >
      <p className="mb-1.5 text-sm text-muted">Priority {project.priority}</p>
      <h3>
        <ProjectTitle
          project={project}
          className={
            lead
              ? "text-2xl leading-tight font-extrabold tracking-[-0.02em] sm:text-[1.75rem]"
              : "text-xl leading-snug font-bold tracking-tight"
          }
        />
      </h3>
      {project.summary && (
        <p className={`mt-2 leading-relaxed text-body ${lead ? "" : "text-[0.95rem]"}`}>
          {project.summary}
        </p>
      )}
      {(project.progress !== null || project.note) && (
        <div className="mt-auto pt-5">
          {project.progress !== null && <ProgressBar project={project} />}
          {project.note && (
            <p className={`text-[0.92rem] text-muted ${project.progress !== null ? "mt-2" : ""}`}>
              {project.note}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** The title, as a link when the project has one. Site paths stay in the tab; others open new. */
function ProjectTitle({ project, className }: { project: Project; className: string }): ReactNode {
  if (!project.url) return <span className={className}>{project.title}</span>;
  const external = !project.url.startsWith("/");
  return (
    <a
      href={project.url}
      className={`${className} decoration-underline decoration-1 underline-offset-4 hover:underline`}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {project.title}
      <ArrowUpRight
        aria-hidden="true"
        className="ml-0.5 inline size-[0.8em] align-baseline text-muted"
      />
    </a>
  );
}

function ProgressBar({ project, compact = false }: { project: Project; compact?: boolean }) {
  const percent = project.progress ?? 0;
  return (
    <div className={`flex items-center gap-3 ${compact ? "w-40" : ""}`}>
      <div
        role="progressbar"
        aria-label={`${project.title} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={`flex-1 overflow-hidden rounded-full bg-line ${compact ? "h-1.5" : "h-2.5"}`}
      >
        <div className="h-full rounded-full bg-fg" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-sm font-semibold text-fg tabular-nums">{percent}%</span>
    </div>
  );
}
