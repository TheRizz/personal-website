import { describe, expect, it, vi } from "vitest";
import { createLobby, lookupLobby } from "./api";

const json = (status: number, body: unknown) =>
  vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("createLobby", () => {
  it("posts JSON and returns the new code", async () => {
    const fetchFn = json(201, { code: "K7QXM2", game: "tictactoe", expiresAt: 1 });
    await expect(createLobby(fetchFn)).resolves.toEqual({ ok: true, code: "K7QXM2" });
    expect(fetchFn).toHaveBeenCalledWith("/api/lobbies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "tictactoe" }),
    });
  });

  it("maps 429 to rate_limited and everything else to failed", async () => {
    await expect(createLobby(json(429, {}))).resolves.toEqual({ ok: false, error: "rate_limited" });
    await expect(createLobby(json(503, {}))).resolves.toEqual({ ok: false, error: "failed" });
    await expect(createLobby(json(201, { code: "nope" }))).resolves.toEqual({
      ok: false,
      error: "failed",
    });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(createLobby(offline)).resolves.toEqual({ ok: false, error: "failed" });
  });
});

describe("lookupLobby", () => {
  it("reports a found lobby and whether it looks full", async () => {
    const summary = { code: "K7QXM2", game: "tictactoe", phase: "waiting", seatsTaken: 1 };
    const lookup = (fields: object) => lookupLobby("K7QXM2", json(200, { ...summary, ...fields }));
    await expect(lookup({ connectedSeats: 1, spectators: 0 })).resolves.toEqual({
      kind: "found",
      full: false,
    });
    await expect(lookup({ seatsTaken: 2, connectedSeats: 2, spectators: 8 })).resolves.toEqual({
      kind: "found",
      full: true,
    });
  });

  it("doesn't count a held seat, which may be the reconnecting player's own", async () => {
    const summary = { code: "K7QXM2", game: "tictactoe", phase: "playing", seatsTaken: 2 };
    await expect(
      lookupLobby("K7QXM2", json(200, { ...summary, connectedSeats: 1, spectators: 8 })),
    ).resolves.toEqual({ kind: "found", full: false });
  });

  it("reports not found and errors", async () => {
    await expect(lookupLobby("K7QXM2", json(404, {}))).resolves.toEqual({ kind: "notFound" });
    await expect(lookupLobby("K7QXM2", json(500, {}))).resolves.toEqual({ kind: "error" });
  });
});
