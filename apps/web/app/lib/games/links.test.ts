import { describe, expect, it } from "vitest";
import { codeFromInput, inviteUrl, lobbyPath, socketUrl } from "./links";

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

  it("takes the code from a typed code or a pasted invite link", () => {
    expect(codeFromInput("k7q-xm2")).toBe("K7QXM2");
    expect(codeFromInput("https://ry-mart.com/games/tictactoe/K7QXM2")).toBe("K7QXM2");
    expect(codeFromInput("https://ry-mart.com/games/tictactoe/k7qxm2/?ref=chat#x")).toBe("K7QXM2");
    expect(codeFromInput("localhost:4391/games/tictactoe/K7QXM2")).toBe("K7QXM2");
    expect(codeFromInput("/games/tictactoe/K7QXM2")).toBe("K7QXM2");
    expect(codeFromInput("ry-mart.com/K7QXM2")).toBe("K7QXM2");
    expect(codeFromInput("https://ry-mart.com/")).toBe("");
  });
});
