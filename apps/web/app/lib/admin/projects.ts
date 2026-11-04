import type { Project, ProjectFields } from "../projects";
import { call, json } from "./drafts";

// Typed calls to the projects API (worker/projects.ts). `call` goes through adminFetch, so the
// owner gate sees the headers it needs, and turns a refusal into an ApiError with its message.

export const listAdminProjects = () =>
  call<{ projects: Project[] }>("/api/admin/projects").then((r) => r.projects);

export const createProject = (fields: ProjectFields) =>
  call<Project>("/api/admin/projects", json("POST", fields));

export const updateProject = (id: string, fields: Partial<ProjectFields>) =>
  call<Project>(`/api/admin/projects/${id}`, json("PATCH", fields));

export const deleteProject = (id: string) =>
  call<void>(`/api/admin/projects/${id}`, { method: "DELETE" });
