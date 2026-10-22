import { TycoonClient } from "@site/tycoon-core";

// The browser's Pipeline Tycoon client (the shared one in tycoon-core, same-origin). The player's
// `<id>.<secret>` lives in localStorage under "games.tycoon.player"; nothing else about the game
// is stored in the browser.

const PLAYER_KEY = "games.tycoon.player";

export const tycoonClient = new TycoonClient({
  baseUrl: "",
  kind: "web",
  store: {
    load() {
      try {
        return window.localStorage.getItem(PLAYER_KEY);
      } catch {
        return null;
      }
    },
    save(credential) {
      try {
        if (credential === null) window.localStorage.removeItem(PLAYER_KEY);
        else window.localStorage.setItem(PLAYER_KEY, credential);
      } catch {
        // Storage blocked: the player lasts as long as this page (the client keeps it in memory).
      }
    },
  },
});
