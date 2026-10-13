/**
 * The port of the local GitHub stub on 127.0.0.1: `E2E_GITHUB_PORT`, else the preview's port
 * (`E2E_PORT`, default 4173) + 1000. `pnpm e2e:keys` writes it into `.dev.vars` before the build,
 * so set the same variables for the build and for the test run.
 */
export function githubStubPort(): number {
  const explicit = process.env.E2E_GITHUB_PORT;
  if (explicit) return Number(explicit);
  return Number(process.env.E2E_PORT ?? 4173) + 1000;
}
