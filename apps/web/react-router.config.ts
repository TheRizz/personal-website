import { readFileSync } from "node:fs";
import type { Config } from "@react-router/dev/config";

const STATIC_ROUTES = [
  "/",
  "/blog",
  "/resume",
  "/snippets",
  "/photos",
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
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
