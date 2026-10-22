import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, fileStore, readConfig } from "./config";

describe("config", () => {
  it("lives in the usual per-user config folder", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe("/x/pipeline-tycoon/config.json");
    expect(configPath({ APPDATA: "C:\\Users\\r\\AppData\\Roaming" }, "win32")).toContain(
      "pipeline-tycoon",
    );
    expect(configPath({ PIPELINE_TYCOON_CONFIG: "/tmp/c.json" }, "linux")).toBe("/tmp/c.json");
  });

  it("stores the credential readable only by the user, and forgets it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tycoon-")), "nested", "config.json");
    const store = fileStore(path);
    expect(store.load()).toBeNull();
    store.save("p.t");
    expect(store.load()).toBe("p.t");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ credential: "p.t" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    store.save(null);
    expect(readConfig(path)).toEqual({});
  });
});
