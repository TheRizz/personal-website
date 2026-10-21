import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/build/",
      "**/.react-router/",
      "**/.wrangler/",
      "**/worker-configuration.d.ts",
      "apps/web/app/generated/",
      "playwright-report/",
      "test-results/",
      // Vendored third-party Claude skill, kept byte for byte with upstream.
      ".claude/skills/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["scripts/**", "**/*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: { globals: globals.node },
    // Playwright fixtures call `use()`, which the hooks rule mistakes for React's use().
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
);
