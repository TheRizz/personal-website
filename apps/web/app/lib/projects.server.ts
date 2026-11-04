import type { Priority, Project, ProjectStatus } from "./projects";

// The D1 reads behind the home page's projects, shared with the Worker's admin API
// (worker/projects.ts). Server only.

export interface ProjectRow {
  id: string;
  title: string;
  summary: string;
  url: string;
  status: ProjectStatus;
  priority: Priority | null;
  progress: number | null;
  note: string;
  created_at: number;
  updated_at: number;
}

export const PROJECT_COLUMNS =
  "id, title, summary, url, status, priority, progress, note, created_at, updated_at";

export const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  url: row.url,
  status: row.status,
  priority: row.priority,
  progress: row.progress,
  note: row.note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Every project, featured first; `groupProjects` puts them in the home page's order. */
export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM projects ` +
        "ORDER BY priority IS NULL, priority, created_at DESC, id",
    )
    .all<ProjectRow>();
  return results.map(toProject);
}
