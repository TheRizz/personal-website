import { TycoonClient, type UnsavedStore } from "@site/tycoon-core";

// The browser's Pipeline Tycoon client (the shared one in tycoon-core, same-origin). The player's
// `<id>.<secret>` lives in localStorage under "games.tycoon.player", and play since the last save
// under "games.tycoon.unsaved" (sent with the next visit if the tab is killed before it saves).
// The game itself lives on the server.

const PLAYER_KEY = "games.tycoon.player";
export const UNSAVED_KEY = "games.tycoon.unsaved";

/** Play not yet saved, kept in localStorage (or nowhere when storage is blocked). */
export const unsavedStore: UnsavedStore = {
  load() {
    try {
      return window.localStorage.getItem(UNSAVED_KEY);
    } catch {
      return null;
    }
  },
  save(value) {
    try {
      if (value === null) window.localStorage.removeItem(UNSAVED_KEY);
      else window.localStorage.setItem(UNSAVED_KEY, value);
    } catch {
      // Storage full or blocked: play is still saved every 5 minutes.
    }
  },
};

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
