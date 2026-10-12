import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Fails when any page outside /admin loads the editor (TipTap/ProseMirror) or the Markdown
// bridge (design doc §4.9.3). Reads the React Router manifest of the client build, then follows
// every static import of the entry and of each public route. Lazy imports (`import(...)`) are not
// followed: those load only when a page asks for them.

const ASSETS = new URL("../apps/web/build/client/assets/", import.meta.url).pathname;
/** Strings only the editor and the bridge contain. */
const MARKERS = [/ProseMirror/, /isn't supported by the editor/];

interface ManifestEntry {
  module: string;
  imports?: string[];
}

const manifestFile = readdirSync(ASSETS).find((name) => /^manifest-.*\.js$/.test(name));
if (!manifestFile) throw new Error(`No React Router manifest in ${ASSETS}; run pnpm build first.`);
const manifest = JSON.parse(
  readFileSync(join(ASSETS, manifestFile), "utf8").replace(
    /^window\.__reactRouterManifest=|;$/g,
    "",
  ),
) as { entry: ManifestEntry; routes: Record<string, ManifestEntry & { id: string }> };

const fileOf = (url: string) => join(ASSETS, url.replace(/^\/assets\//, ""));

/** Every file `start` loads through static imports, itself included. */
function staticGraph(start: string, seen = new Set<string>()): Set<string> {
  if (seen.has(start)) return seen;
  seen.add(start);
  const code = readFileSync(start, "utf8");
  for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) {
    staticGraph(join(ASSETS, match[1]!), seen);
  }
  return seen;
}

const isAdmin = (id: string) => id === "routes/admin" || id.startsWith("routes/admin.");
const publicEntries: [string, ManifestEntry][] = [
  ["entry", manifest.entry],
  ...Object.entries(manifest.routes).filter(([id]) => !isAdmin(id)),
];

const problems: string[] = [];
for (const [id, entry] of publicEntries) {
  const files = new Set<string>();
  for (const url of [entry.module, ...(entry.imports ?? [])]) staticGraph(fileOf(url), files);
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const marker = MARKERS.find((pattern) => pattern.test(code));
    if (marker) problems.push(`${id} loads ${file.slice(ASSETS.length)} (matches ${marker})`);
  }
}

if (problems.length > 0) {
  console.error("Public pages load admin-only code:\n" + problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Checked ${publicEntries.length} public entries: no editor or bridge code.`);
