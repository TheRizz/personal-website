import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  define: {
    // Reported by /api/health so the deploy smoke test can check the live version.
    __APP_VERSION__: JSON.stringify(process.env.GITHUB_SHA ?? "dev"),
  },
  // Pre-bundle deps that are otherwise discovered late, which reloads and breaks a cold `vite dev`.
  // zod is only reachable through the workspace game-core package, hence the nested form.
  optimizeDeps: { include: ["lucide-react", "@site/game-core > zod"] },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
