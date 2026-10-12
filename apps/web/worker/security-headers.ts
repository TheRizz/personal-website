// Shared by the Worker (responses it renders) and the build (the `_headers` file for prerendered
// pages and other static assets), so both serve the same policy (design doc §4.8).

/** The production origin. */
export const SITE_ORIGIN = "https://ry-mart.com";
const PHOTOS_ORIGIN = "https://photos.ry-mart.com";
// Cloudflare Web Analytics (hosting guide §2.6) injects its beacon script at the edge.
const ANALYTICS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
const ANALYTICS_REPORT_ORIGIN = "https://cloudflareinsights.com";

/** Headers every response gets, from the Worker or from static assets. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

interface PolicyOptions {
  /** Sources for the page's inline scripts: a per-request nonce or one sha256 hash per script. */
  inlineScripts?: string[];
  /** The page's own WebSocket origin. CSP3 matches it with 'self', but older Safari doesn't. */
  socketOrigin?: string;
}

/** The site-wide CSP: an inline script runs only if its nonce or hash is listed. */
export function contentSecurityPolicy({
  inlineScripts = [],
  socketOrigin = SITE_ORIGIN.replace(/^https:/, "wss:"),
}: PolicyOptions = {}): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inlineScripts, ANALYTICS_SCRIPT_ORIGIN].join(" "),
    // Shiki colours code with style attributes, and React writes a few inline styles.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${PHOTOS_ORIGIN} data:`,
    // Vite inlines the smallest font files as data: URIs.
    "font-src 'self' data:",
    `connect-src 'self' ${socketOrigin} ${ANALYTICS_REPORT_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh CSP nonce (128 random bits, base64). */
export function createNonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/** The CSP source that allows an inline script with exactly this text. */
export async function scriptHashSource(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `'sha256-${toBase64(new Uint8Array(digest))}'`;
}

// React's server output: attributes never contain ">", and script text never contains "</script".
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** Hash sources for every inline script in an HTML document, in order, without duplicates. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const scripts = [...html.matchAll(INLINE_SCRIPT)].map((match) => match[1] ?? "");
  return [...new Set(await Promise.all(scripts.map(scriptHashSource)))];
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
