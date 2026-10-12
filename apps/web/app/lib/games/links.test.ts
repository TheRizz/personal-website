import { describe, expect, it } from "vitest";
import { inviteUrl, lobbyPath, socketUrl } from "./links";

describe("links", () => {
  it("builds the lobby path and invite link", () => {
    expect(lobbyPath("K7QXM2")).toBe("/games/tictactoe/K7QXM2");
    expect(inviteUrl("https://ry-mart.com", "K7QXM2")).toBe(
      "https://ry-mart.com/games/tictactoe/K7QXM2",
    );
    expect(inviteUrl("http://localhost:5173", "K7QXM2")).toBe(
      "http://localhost:5173/games/tictactoe/K7QXM2",
    );
  });

  it("uses a same-origin socket URL with the matching scheme", () => {
    expect(socketUrl({ protocol: "https:", host: "ry-mart.com" }, "K7QXM2")).toBe(
      "wss://ry-mart.com/api/lobbies/K7QXM2/ws",
    );
    expect(socketUrl({ protocol: "http:", host: "localhost:5173" }, "K7QXM2")).toBe(
      "ws://localhost:5173/api/lobbies/K7QXM2/ws",
    );
  });
});
