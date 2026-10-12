import type { RouteConfigEntry } from "@react-router/dev/routes";
import { describe, expect, it } from "vitest";
import routes from "./routes";

const modules = import.meta.glob<Record<string, unknown>>(["./root.tsx", "./routes/**/*.tsx"]);

/** Route files whose full path is /admin or below it. */
function adminFiles(entries: RouteConfigEntry[], parent = ""): string[] {
  return entries.flatMap((entry) => {
    const path = [parent, entry.path].filter(Boolean).join("/");
    const own = path === "admin" || path.startsWith("admin/") ? [entry.file] : [];
    return [...own, ...adminFiles(entry.children ?? [], path)];
  });
}

describe("admin routes", () => {
  // The client must never need /admin.data, which the owner gate refuses, and no admin data may
  // be rendered on the server (design doc §4.9.1).
  it.each(["root.tsx", ...adminFiles(routes)])(
    "%s exports no server loader or action",
    async (file) => {
      const load = modules[`./${file}`];
      expect(load, `${file} not found`).toBeDefined();
      const module = await load!();
      expect(module.loader).toBeUndefined();
      expect(module.action).toBeUndefined();
    },
  );
});
