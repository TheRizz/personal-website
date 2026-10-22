// Builds the CLI and lays out exactly what goes to npm in ./publish: the bundle, the README and
// a package.json without the workspace-only parts (scripts, devDependencies). The bundle has no
// runtime dependencies, so neither does the published package.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const here = (path) => new URL(path, import.meta.url).pathname;
await import("./build.mjs");

const published = JSON.parse(readFileSync(here("./package.json"), "utf8"));
delete published.scripts;
delete published.devDependencies;

rmSync(here("./publish"), { recursive: true, force: true });
mkdirSync(here("./publish/dist"), { recursive: true });
copyFileSync(here("./dist/cli.js"), here("./publish/dist/cli.js"));
copyFileSync(here("./README.md"), here("./publish/README.md"));
writeFileSync(here("./publish/package.json"), `${JSON.stringify(published, null, 2)}\n`);
console.log(`Staged ${published.name}@${published.version} in ${here("./publish")}`);
