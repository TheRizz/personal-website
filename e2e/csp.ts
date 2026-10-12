import { createHash } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";

// Shared by the specs that check the CSP (design doc §4.8, §4.9.8).

declare global {
  interface Window {
    cspViolations?: string[];
  }
}

interface CspTestOptions {
  /** Headers every request from the page carries. */
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  /** Also fail on console errors (except the browser's own line for a non-2xx response). */
  consoleErrors?: boolean;
}

/**
 * A test whose page records every CSP violation (console message or `securitypolicyviolation`
 * event) and every uncaught error; the test fails if there are any.
 */
export function cspTest({ headers, consoleErrors = false }: CspTestOptions) {
  return base.extend<{ page: Page }>({
    page: async ({ browser }, use) => {
      const context = await browser.newContext({ extraHTTPHeaders: await headers() });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on("console", (message) => {
        const text = message.text();
        if (/Content.Security.Policy/i.test(text)) problems.push(text);
        // The tests check non-2xx statuses themselves.
        else if (consoleErrors && message.type() === "error") {
          if (!text.startsWith("Failed to load resource:")) problems.push(text);
        }
      });
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          (window.cspViolations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      await use(page);
      problems.push(...(await page.evaluate(() => window.cspViolations ?? [])));
      await context.close();
      expect(problems).toEqual([]);
    },
  });
}

/** The CSP source that allows an inline script with exactly this text. */
export const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/**
 * Every inline (non-src) script in an HTML document. Written independently of the Worker's own
 * matcher (worker/security-headers.ts), so the tests don't share its mistakes.
 */
export function inlineScripts(html: string): { attributes: string; text: string }[] {
  return [...html.matchAll(/<script\b(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].map(
    ([, attributes = "", text = ""]) => ({ attributes, text }),
  );
}
