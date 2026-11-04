import { beforeEach, describe, expect, it } from "vitest";
import { groupProjects, isProjectUrl, type Project } from "../app/lib/projects";
import { createD1 } from "./d1-fake";
import { handleProjects } from "./projects";

// The projects API against a real SQLite database with the shipped migrations.

const SITE = "https://ry-mart.com";
let db: D1Database;

beforeEach(async () => {
  ({ db } = await createD1());
});

async function call(method: string, path = "", body?: unknown) {
  const response = await handleProjects(
    new Request(`${SITE}/api/admin/projects${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { DB: db },
  );
  if (!response) throw new Error(`no route for ${method} ${path}`);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

const create = async (body: Record<string, unknown>) => {
  const { status, json } = await call("POST", "", body);
  expect(status).toBe(201);
  return json as Project;
};
const list = async () => (await call("GET")).json.projects as Project[];

describe("projects API", () => {
  it("ignores other paths", async () => {
    const response = await handleProjects(new Request(`${SITE}/api/admin/photos`), { DB: db });
    expect(response).toBeNull();
  });

  it("creates a project with defaults and cleaned text", async () => {
    const project = await create({ title: "  Pipeline\n Tycoon ", progress: 40 });
    expect(project).toMatchObject({
      title: "Pipeline Tycoon",
      summary: "",
      url: "",
      status: "active",
      priority: null,
      progress: 40,
      note: "",
    });
    expect(await list()).toEqual([project]);
  });

  it("refuses bad fields", async () => {
    for (const body of [
      {},
      { title: "" },
      { title: "x".repeat(81) },
      { title: "A", priority: 4 },
      { title: "A", progress: 101 },
      { title: "A", progress: 2.5 },
      { title: "A", status: "done" },
      { title: "A", url: "javascript:alert(1)" },
      { title: "A", url: "//evil.example" },
      { title: "A", status: "backlog", priority: 1 },
      { title: "A", colour: "red" },
    ]) {
      expect((await call("POST", "", body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it("moves a priority instead of sharing it", async () => {
    const first = await create({ title: "First", priority: 1 });
    const second = await create({ title: "Second", priority: 2 });
    const { json: moved } = await call("PATCH", `/${second.id}`, { priority: 1 });
    expect(moved.priority).toBe(1);
    const byId = Object.fromEntries((await list()).map((p) => [p.id, p.priority]));
    expect(byId).toEqual({ [first.id]: null, [second.id]: 1 });

    // A new project can take a slot too.
    const third = await create({ title: "Third", priority: 1 });
    const after = Object.fromEntries((await list()).map((p) => [p.id, p.priority]));
    expect(after).toEqual({ [first.id]: null, [second.id]: null, [third.id]: 1 });
  });

  it("drops the priority when a project goes to the backlog", async () => {
    const project = await create({ title: "Volley", priority: 3 });
    const { json } = await call("PATCH", `/${project.id}`, { status: "backlog" });
    expect(json).toMatchObject({ status: "backlog", priority: null });
    expect((await call("PATCH", `/${project.id}`, { priority: 2 })).status).toBe(422);
    const { json: back } = await call("PATCH", `/${project.id}`, { status: "active", priority: 2 });
    expect(back).toMatchObject({ status: "active", priority: 2 });
  });

  it("updates only the fields sent and clears progress with null", async () => {
    const project = await create({ title: "Site", summary: "Home page", progress: 10, note: "Hi" });
    const { json } = await call("PATCH", `/${project.id}`, { progress: null, url: "/games" });
    expect(json).toMatchObject({
      title: "Site",
      summary: "Home page",
      progress: null,
      note: "Hi",
      url: "/games",
    });
  });

  it("deletes a project", async () => {
    const project = await create({ title: "Gone" });
    expect((await call("DELETE", `/${project.id}`)).status).toBe(204);
    expect((await call("DELETE", `/${project.id}`)).status).toBe(404);
    expect((await call("PATCH", `/${project.id}`, { title: "x" })).status).toBe(404);
    expect(await list()).toEqual([]);
  });
});

describe("groupProjects", () => {
  const project = (id: string, extra: Partial<Project>): Project => ({
    id,
    title: id,
    summary: "",
    url: "",
    status: "active",
    priority: null,
    progress: null,
    note: "",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  });

  it("puts priorities in order, then the rest newest first, then the backlog", () => {
    const groups = groupProjects([
      project("old", { createdAt: 1 }),
      project("p3", { priority: 3 }),
      project("idea", { status: "backlog" }),
      project("p1", { priority: 1 }),
      project("new", { createdAt: 2 }),
    ]);
    expect(groups.featured.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(groups.others.map((p) => p.id)).toEqual(["new", "old"]);
    expect(groups.backlog.map((p) => p.id)).toEqual(["idea"]);
  });
});

describe("isProjectUrl", () => {
  it.each([
    ["", true],
    ["/games/volley", true],
    ["https://github.com/TheRizz", true],
    ["http://example.com", true],
    ["//example.com", false],
    ["javascript:alert(1)", false],
    ["mailto:me@example.com", false],
    ["https://exa mple.com", false],
  ])("%s → %s", (url, ok) => expect(isProjectUrl(url)).toBe(ok));
});
