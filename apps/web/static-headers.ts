import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SECURITY_HEADERS,
  contentSecurityPolicy,
  inlineScriptHashes,
} from "./worker/security-headers";

// Limits of the `_headers` file on Workers Static Assets.
const MAX_RULES = 100;
const MAX_LINE_LENGTH = 2000;

/** The URL path a prerendered HTML file is served at (`html_handling: drop-trailing-slash`). */
function pagePath(file: string): string {
  const route = file
    .split(path.sep)
    .join("/")
    .replace(/(^|\/)index\.html$/, "")
    .replace(/\.html$/, "");
  return `/${route}`;
}

/**
 * Writes `_headers` into the client build: the security headers for every static asset, and for
 * each prerendered page a CSP that allows exactly that page's inline scripts by sha256 hash. A
 * static file can't carry a per-request nonce, and React Router inlines each page's loader data,
 * so every page needs its own hashes.
 */
export async function writeStaticHeaders(clientDir: string): Promise<void> {
  const files = (await readdir(clientDir, { recursive: true }))
    .filter((file) => file.endsWith(".html"))
    .sort();

  const rules = [
    [
      "/*",
      ...Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`),
      `Content-Security-Policy: ${contentSecurityPolicy()}`,
    ],
  ];
  for (const file of files) {
    const html = await readFile(path.join(clientDir, file), "utf8");
    const policy = contentSecurityPolicy({ inlineScripts: await inlineScriptHashes(html) });
    // `!` drops the site-wide policy first: two CSP headers would both be enforced.
    rules.push([pagePath(file), "! Content-Security-Policy", `Content-Security-Policy: ${policy}`]);
  }

  if (rules.length > MAX_RULES) {
    throw new Error(
      `_headers would need ${rules.length} rules, over the limit of ${MAX_RULES}. ` +
        "Move per-page script hashes into a <meta http-equiv> CSP instead.",
    );
  }
  const text = rules.map(([pattern, ...headers]) =>
    [pattern, ...headers.map((header) => `  ${header}`)].join("\n"),
  );
  const tooLong = text
    .flatMap((rule) => rule.split("\n"))
    .find((line) => line.length > MAX_LINE_LENGTH);
  if (tooLong) throw new Error(`_headers line is over ${MAX_LINE_LENGTH} characters: ${tooLong}`);
  await writeFile(path.join(clientDir, "_headers"), `${text.join("\n\n")}\n`);
}
