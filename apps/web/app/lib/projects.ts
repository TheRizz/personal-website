// Current projects, shown at the top of the home page and edited at /admin/projects. Shared by the
// Worker (worker/projects.ts), the admin page and the home page.

export const MAX_TITLE_LENGTH = 80;
export const MAX_SUMMARY_LENGTH = 280;
export const MAX_NOTE_LENGTH = 120;
export const MAX_URL_LENGTH = 500;

export type ProjectStatus = "active" | "backlog";
export type Priority = 1 | 2 | 3;

/** A project as the home page and the admin page see it. */
export interface Project {
  id: string;
  title: string;
  /** One or two plain-text sentences; empty for none. */
  summary: string;
  /** An http(s) link, or a path on this site starting with "/"; empty for none. */
  url: string;
  status: ProjectStatus;
  /** 1, 2 or 3 for the featured slots; null for every other project. Always null in the backlog. */
  priority: Priority | null;
  /** Percent done, 0 to 100; null when progress isn't tracked as a number. */
  progress: number | null;
  /** A short status line, such as "Waiting on playtest"; empty for none. */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** The fields the admin page sends. */
export type ProjectFields = Pick<
  Project,
  "title" | "summary" | "url" | "status" | "priority" | "progress" | "note"
>;

/** The home page's three groups. */
export interface ProjectGroups {
  featured: Project[];
  others: Project[];
  backlog: Project[];
}

/** Splits projects into the home page's groups: priorities in order, then the rest, then backlog. */
export function groupProjects(projects: readonly Project[]): ProjectGroups {
  const byNewest = (a: Project, b: Project) =>
    b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  const active = projects.filter((project) => project.status === "active");
  return {
    featured: active
      .filter((project) => project.priority !== null)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)),
    others: active.filter((project) => project.priority === null).sort(byNewest),
    backlog: projects.filter((project) => project.status === "backlog").sort(byNewest),
  };
}

/** A one-line text field as stored: line breaks and runs of spaces collapsed, trimmed. */
export const cleanLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether a link is one the site will render: http(s), or a path on this site. */
export function isProjectUrl(url: string): boolean {
  if (url === "") return true;
  if (url.length > MAX_URL_LENGTH || /\s/.test(url)) return false;
  if (url.startsWith("/")) return !url.startsWith("//");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
