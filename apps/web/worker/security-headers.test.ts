import { describe, expect, it } from "vitest";
import {
  adminContentSecurityPolicy,
  contentSecurityPolicy,
  createNonce,
  inlineScriptHashes,
} from "./security-headers";

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

describe("contentSecurityPolicy", () => {
  it("allows no inline script by default", () => {
    const policy = contentSecurityPolicy();
    expect(policy).toContain("script-src 'self' https://static.cloudflareinsights.com;");
    expect(policy).not.toContain("'unsafe-inline' ");
    expect(policy).toContain("img-src 'self' https://photos.ry-mart.com data:");
    expect(policy).toContain("connect-src 'self' wss://ry-mart.com");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("lists the given script sources and socket origin", () => {
    const policy = contentSecurityPolicy({
      inlineScripts: ["'nonce-abc'"],
      socketOrigin: "ws://localhost:4173",
    });
    expect(policy).toContain("script-src 'self' 'nonce-abc' ");
    expect(policy).toContain("connect-src 'self' ws://localhost:4173 ");
  });
});

describe("adminContentSecurityPolicy", () => {
  it("is the stricter admin policy from the design doc", () => {
    expect(adminContentSecurityPolicy({ inlineScripts: ["'nonce-abc'", "'sha256-x'"] })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-abc' 'sha256-x' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https://photos.ry-mart.com blob: data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });

  it("allows no inline script, analytics or WebSocket by default", () => {
    const policy = adminContentSecurityPolicy();
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(policy).not.toContain("cloudflareinsights");
    expect(policy).not.toContain("wss:");
  });
});

describe("inlineScriptHashes", () => {
  it("hashes each distinct inline script and skips external ones", async () => {
    const html = [
      "<script>a()</script>",
      '<script type="module" async="">import "/x.js";\n</script>',
      '<script src="/assets/entry.js"></script>',
      '<script id="_R_">a()</script>',
      "<script></script>",
    ].join("");
    expect(await inlineScriptHashes(html)).toEqual([
      await sha256("a()"),
      await sha256('import "/x.js";\n'),
      await sha256(""),
    ]);
  });
});

describe("createNonce", () => {
  it("is 128 random bits, fresh each time", () => {
    const nonce = createNonce();
    expect(atob(nonce)).toHaveLength(16);
    expect(createNonce()).not.toBe(nonce);
  });
});
