import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER, UsageError, parseArgs } from "./args";

describe("parseArgs", () => {
  it("plays by default against ry-mart.com", () => {
    expect(parseArgs([], {})).toEqual({
      command: { kind: "play" },
      server: DEFAULT_SERVER,
      color: null,
    });
  });

  it("reads link codes however they're typed", () => {
    expect(parseArgs(["link", "ABC", "234"], {}).command).toEqual({ kind: "link", code: "ABC234" });
    expect(parseArgs(["link", "abc-234"], {}).command).toEqual({ kind: "link", code: "abc-234" });
    expect(() => parseArgs(["link"], {})).toThrow(UsageError);
  });

  it("takes a server from --server or the environment, https only (http for localhost)", () => {
    expect(parseArgs(["--server", "http://localhost:4173/"], {}).server).toBe(
      "http://localhost:4173",
    );
    expect(parseArgs([], { PIPELINE_TYCOON_SERVER: "https://example.com" }).server).toBe(
      "https://example.com",
    );
    expect(() => parseArgs(["--server=http://example.com"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--server", "nope"], {})).toThrow(UsageError);
  });

  it("rejects unknown commands and options", () => {
    expect(() => parseArgs(["dance"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--turbo"], {})).toThrow(UsageError);
    expect(parseArgs(["--help"], {}).command).toEqual({ kind: "help" });
    expect(parseArgs(["-v"], {}).command).toEqual({ kind: "version" });
    expect(parseArgs(["--no-color"], {}).color).toBe(false);
  });
});
