import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialStore } from "@site/tycoon-core";

// Where the CLI keeps its player: one small JSON file, readable only by you.
//   Linux/macOS: $XDG_CONFIG_HOME/pipeline-tycoon/config.json (default ~/.config/…)
//   Windows:     %APPDATA%\pipeline-tycoon\config.json

export interface Config {
  /** `<player>.<secret>` for this device. */
  credential?: string;
}

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (env.PIPELINE_TYCOON_CONFIG) return env.PIPELINE_TYCOON_CONFIG;
  const base =
    platform === "win32"
      ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "pipeline-tycoon", "config.json");
}

export function readConfig(path: string): Config {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const credential = (parsed as Record<string, unknown>).credential;
      return typeof credential === "string" ? { credential } : {};
    }
  } catch {
    // Missing or unreadable: no player yet.
  }
  return {};
}

export function writeConfig(path: string, config: Config): void {
  if (!config.credential) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The mode above only applies to new files.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported (Windows); the file is in the user's own profile there.
  }
}

/** The credential store the shared client uses, backed by the config file. */
export function fileStore(path: string): CredentialStore {
  return {
    load: () => readConfig(path).credential ?? null,
    save: (credential) => writeConfig(path, credential ? { credential } : {}),
  };
}
