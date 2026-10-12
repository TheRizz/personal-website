import type { Highlighter, SHIKI_LANGS } from "@site/content-markdown";
import type { LanguageRegistration, ThemeRegistration } from "shiki/core";

// Shiki for the editor preview, fine-grained: only the languages in SHIKI_LANGS, the site's two
// themes and the JavaScript regex engine (no WebAssembly). Loaded on the first preview.

type Module<T> = Promise<{ default: T }>;

const LANGS: Record<(typeof SHIKI_LANGS)[number], () => Module<LanguageRegistration[]>> = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  dockerfile: () => import("shiki/dist/langs/dockerfile.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
};

const THEMES: (() => Module<ThemeRegistration>)[] = [
  () => import("shiki/dist/themes/github-light.mjs"),
  () => import("shiki/dist/themes/github-dark.mjs"),
];

export async function createPreviewHighlighter(): Promise<Highlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  return createHighlighterCore({
    themes: THEMES.map((load) => load()),
    langs: Object.values(LANGS).map((load) => load()),
    engine: createJavaScriptRegexEngine(),
  }) as unknown as Promise<Highlighter>;
}
