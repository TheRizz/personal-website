import { adminFetch } from "./api";

// Typed calls to the drafts API (worker/drafts.ts, design doc §4.9.5). Every request goes through
// adminFetch, so the owner gate sees the headers it needs.

/** The fields the editor edits; any subset on a save. */
export interface DraftFields {
  title: string;
  summary: string;
  category: string | null;
  tags: string[];
  bodyMd: string;
}

export interface Draft extends DraftFields {
  id: string;
  kind: "new" | "edit";
  sourcePath: string | null;
  slug: string | null;
  cover: string | null;
  rev: number;
  status: string;
  prNumber: number | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface DraftSummary {
  id: string;
  kind: "new" | "edit";
  slug: string | null;
  title: string;
  summary: string;
  rev: number;
  status: string;
  updatedAt: number;
}

export interface Revision {
  rev: number;
  title: string;
  reason: "interval" | "manual" | "publish" | "restore" | "conflict";
  createdAt: number;
}

export type SaveReason = "interval" | "manual" | "conflict";

/** A request the API refused, with its status and error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(path, init);
  if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  throw new ApiError(
    response.status,
    body.error?.code ?? "error",
    body.error?.message ?? `Request failed (${response.status}).`,
  );
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const listDrafts = () =>
  call<{ drafts: DraftSummary[] }>("/api/admin/drafts").then((r) => r.drafts);

export const createDraft = (fields: Partial<DraftFields> = {}) =>
  call<{ id: string; rev: number }>("/api/admin/drafts", json("POST", fields));

export const getDraft = (id: string) => call<Draft>(`/api/admin/drafts/${id}`);

/** The result of a save: the new rev, or the rev another tab saved first. */
export type SaveResult = { ok: true; rev: number } | { ok: false; rev: number; updatedAt: number };

export async function saveDraft(
  id: string,
  baseRev: number,
  fields: Partial<DraftFields>,
  revision?: SaveReason,
): Promise<SaveResult> {
  const response = await adminFetch(
    `/api/admin/drafts/${id}`,
    json("PUT", { baseRev, ...fields, ...(revision && { revision }) }),
  );
  if (response.ok) return { ok: true, ...((await response.json()) as { rev: number }) };
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
    rev?: number;
    updatedAt?: number;
  };
  if (response.status === 409 && typeof body.rev === "number") {
    return { ok: false, rev: body.rev, updatedAt: body.updatedAt ?? 0 };
  }
  throw new ApiError(
    response.status,
    body.error?.code ?? "error",
    body.error?.message ?? `Save failed (${response.status}).`,
  );
}

export const discardDraft = (id: string) =>
  call<void>(`/api/admin/drafts/${id}`, { method: "DELETE" });

export const listRevisions = (id: string) =>
  call<{ revisions: Revision[] }>(`/api/admin/drafts/${id}/revisions`).then((r) => r.revisions);

export const restoreRevision = (id: string, rev: number, baseRev: number) =>
  call<{ rev: number }>(
    `/api/admin/drafts/${id}/revisions/${rev}/restore`,
    json("POST", { baseRev }),
  );
