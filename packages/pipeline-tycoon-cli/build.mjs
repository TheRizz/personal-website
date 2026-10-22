// Bundles the CLI and everything it uses (the shared rules, zod) into one file, so the published
// package has no dependencies to install.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: [new URL("./src/cli.ts", import.meta.url).pathname],
  outfile: new URL("./dist/cli.js", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  define: { __CLI_VERSION__: JSON.stringify(version) },
});
