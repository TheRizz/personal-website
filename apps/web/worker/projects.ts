import {
  MAX_NOTE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  cleanLine,
  isProjectUrl,
  type Priority,
  type ProjectFields,
  type ProjectStatus,
} from "../app/lib/projects";
import {
  PROJECT_COLUMNS,
  listProjects,
  toProject,
  type ProjectRow,
} from "../app/lib/projects.server";
import { jsonError, methodNotAllowed } from "./api";
import { readJson } from "./images";

// The home page's current projects. The admin router mounts this behind the owner gate, so nothing
// here checks access. A change is live at once: the home page reads D1 on each (cached) request.

/** The bindings this module uses. */
export type ProjectsEnv = Pick<Env, "DB">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTE = /^\/api\/admin\/projects(?:\/([^/]+))?$/;
/** Enough for a personal list; stops a runaway script, not a person. */
const MAX_PROJECTS = 200;
const FIELDS = new Set(["title", "summary", "url", "status", "priority", "progress", "note"]);

const noStore = { "Cache-Control": "no-store" };
const projectNotFound = () => jsonError(404, "not_found", "No such project.");
const invalid = (message: string) => jsonError(422, "invalid_project", message);

/** Routes /api/admin/projects and below. Returns null for any other path. */
export async function handleProjects(request: Request, env: ProjectsEnv): Promise<Response | null> {
  const match = ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, id] = match;
  const { method } = request;

  if (id === undefined) {
    if (method === "GET")
      return Response.json({ projects: await listProjects(env.DB) }, { headers: noStore });
    if (method === "POST") return createProject(request, env.DB);
    return methodNotAllowed("GET, POST");
  }
  if (!UUID.test(id)) return projectNotFound();
  if (method === "PATCH") return updateProject(request, env.DB, id);
  if (method === "DELETE") return deleteProject(env.DB, id);
  return methodNotAllowed("PATCH, DELETE");
}

/** A text field: absent, or a string no longer than `max` once cleaned. */
function text(
  body: Record<string, unknown>,
  name: "title" | "summary" | "note",
  max: number,
): string | undefined | Response {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid(`${name} must be text.`);
  const cleaned = cleanLine(value);
  if (cleaned.length > max) return invalid(`${name} can be at most ${max} characters.`);
  return cleaned;
}

/** The fields present in `body`, checked. Unknown fields are refused. */
function readFields(body: Record<string, unknown>): Partial<ProjectFields> | Response {
  const unknown = Object.keys(body).filter((key) => !FIELDS.has(key));
  if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(", ")}.`);
  const fields: Partial<ProjectFields> = {};

  const title = text(body, "title", MAX_TITLE_LENGTH);
  if (title instanceof Response) return title;
  if (title !== undefined) {
    if (title === "") return invalid("A project needs a title.");
    fields.title = title;
  }
  const summary = text(body, "summary", MAX_SUMMARY_LENGTH);
  if (summary instanceof Response) return summary;
  if (summary !== undefined) fields.summary = summary;
  const note = text(body, "note", MAX_NOTE_LENGTH);
  if (note instanceof Response) return note;
  if (note !== undefined) fields.note = note;

  if (body.url !== undefined) {
    if (typeof body.url !== "string") return invalid("url must be text.");
    const url = body.url.trim();
    if (!isProjectUrl(url)) {
      return invalid("The link must start with https://, http:// or / (a page on this site).");
    }
    fields.url = url;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "backlog") {
      return invalid("status must be active or backlog.");
    }
    fields.status = body.status as ProjectStatus;
  }
  if (body.priority !== undefined) {
    if (
      body.priority !== null &&
      body.priority !== 1 &&
      body.priority !== 2 &&
      body.priority !== 3
    ) {
      return invalid("priority must be 1, 2, 3 or null.");
    }
    fields.priority = body.priority as Priority | null;
  }
  if (body.progress !== undefined) {
    const { progress } = body;
    if (
      progress !== null &&
      !(
        typeof progress === "number" &&
        Number.isInteger(progress) &&
        progress >= 0 &&
        progress <= 100
      )
    ) {
      return invalid("progress must be a whole number from 0 to 100, or null.");
    }
    fields.progress = progress as number | null;
  }
  if (fields.status === "backlog" && fields.priority != null) {
    return invalid("A backlog project can't have a priority.");
  }
  return fields;
}

/**
 * Writes a project's final fields. Taking a priority moves it: whichever other project held it
 * loses it, in the same batch, so there is never a gap where two projects share one.
 */
async function save(db: D1Database, id: string, project: ProjectFields, create: number | null) {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (project.priority !== null) {
    statements.push(
      db
        .prepare(
          "UPDATE projects SET priority = NULL, updated_at = ? WHERE priority = ? AND id != ?",
        )
        .bind(now, project.priority, id),
    );
  }
  const values = [
    project.title,
    project.summary,
    project.url,
    project.status,
    project.priority,
    project.progress,
    project.note,
  ];
  statements.push(
    create === null
      ? db
          .prepare(
            "UPDATE projects SET title = ?, summary = ?, url = ?, status = ?, priority = ?, " +
              `progress = ?, note = ?, updated_at = ? WHERE id = ? RETURNING ${PROJECT_COLUMNS}`,
          )
          .bind(...values, now, id)
      : db
          .prepare(
            "INSERT INTO projects (title, summary, url, status, priority, progress, note, " +
              `updated_at, created_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${PROJECT_COLUMNS}`,
          )
          .bind(...values, now, create, id),
  );
  const results = await db.batch<ProjectRow>(statements);
  const row = results.at(-1)?.results[0];
  return row ? toProject(row) : null;
}

/** `{title, summary?, url?, status?, priority?, progress?, note?}`: adds a project. */
async function createProject(request: Request, db: D1Database): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const fields = readFields(body);
  if (fields instanceof Response) return fields;
  if (fields.title === undefined) return invalid("A project needs a title.");

  const count = await db.prepare("SELECT count(*) AS n FROM projects").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PROJECTS) {
    return invalid(`You can have at most ${MAX_PROJECTS} projects. Delete some first.`);
  }
  const status = fields.status ?? "active";
  const project = await save(
    db,
    crypto.randomUUID(),
    {
      title: fields.title,
      summary: fields.summary ?? "",
      url: fields.url ?? "",
      status,
      priority: status === "backlog" ? null : (fields.priority ?? null),
      progress: fields.progress ?? null,
      note: fields.note ?? "",
    },
    Date.now(),
  );
  return Response.json(project, { status: 201, headers: noStore });
}

/** Any subset of the fields: changes a project. Moving it to the backlog drops its priority. */
async function updateProject(request: Request, db: D1Database, id: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const fields = readFields(body);
  if (fields instanceof Response) return fields;

  const row = await db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
    .bind(id)
    .first<ProjectRow>();
  if (!row) return projectNotFound();
  const current = toProject(row);
  const next: ProjectFields = {
    title: fields.title ?? current.title,
    summary: fields.summary ?? current.summary,
    url: fields.url ?? current.url,
    status: fields.status ?? current.status,
    priority: fields.priority !== undefined ? fields.priority : current.priority,
    progress: fields.progress !== undefined ? fields.progress : current.progress,
    note: fields.note ?? current.note,
  };
  if (next.status === "backlog") {
    if (fields.priority != null) return invalid("A backlog project can't have a priority.");
    next.priority = null;
  }
  const project = await save(db, id, next, null);
  if (!project) return projectNotFound();
  return Response.json(project, { headers: noStore });
}

async function deleteProject(db: D1Database, id: string): Promise<Response> {
  const deleted = await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
  if (deleted.meta.changes === 0) return projectNotFound();
  return new Response(null, { status: 204, headers: noStore });
}
