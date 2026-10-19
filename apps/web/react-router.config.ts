import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "@react-router/dev/config";
import { writeStaticHeaders } from "./static-headers";

const STATIC_ROUTES = [
  "/",
  "/blog",
  "/resume",
  "/snippets",
  "/games",
  "/games/tictactoe",
  "/search",
];

export default {
  ssr: true,
  // Every content page is rendered to HTML at build time and served as a static asset.
  async prerender() {
    const posts: { slug: string }[] = JSON.parse(
      readFileSync(new URL("./app/generated/posts.json", import.meta.url), "utf8"),
    );
    return [...STATIC_ROUTES, ...posts.map((post) => `/blog/${post.slug}`)];
  },
  // Runs after prerendering, so it can hash each page's inline scripts.
  async buildEnd({
    viteConfig,
    reactRouterConfig,
  }: {
    viteConfig: { root: string };
    reactRouterConfig: { buildDirectory: string };
  }) {
    await writeStaticHeaders(
      path.resolve(viteConfig.root, reactRouterConfig.buildDirectory, "client"),
    );
  },
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
