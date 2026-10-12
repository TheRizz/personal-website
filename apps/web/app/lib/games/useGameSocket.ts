import { useEffect, useState, useSyncExternalStore } from "react";
import { lookupLobby } from "./api";
import { viewState } from "./client-state";
import { GameClient } from "./game-client";
import { socketUrl } from "./links";
import { loadToken, saveToken } from "./storage";

/**
 * Live connection to a tic-tac-toe lobby. Joins with the tab's saved seat token, keeps the socket
 * alive, reconnects with backoff and applies moves optimistically. `code` and `name` are read
 * once: remount (e.g. with `key`) to change them.
 */
export function useGameSocket(code: string, name: string) {
  const [client] = useState(
    () =>
      new GameClient(name, {
        openSocket: () => new WebSocket(socketUrl(window.location, code)),
        lookupLobby: () => lookupLobby(code),
        loadToken: () => loadToken(code),
        saveToken: (token) => saveToken(code, token),
      }),
  );
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  useEffect(() => {
    client.start();
    return client.stop;
  }, [client]);

  return {
    /** The lobby as it should be drawn (server snapshot plus any pending move). */
    state: viewState(snapshot),
    seq: snapshot.server?.seq ?? null,
    role: snapshot.role,
    connection: snapshot.connection,
    attempt: snapshot.attempt,
    pendingCell: snapshot.pending?.cell ?? null,
    lastError: snapshot.lastError,
    send: client.send,
    play: client.play,
    rematch: client.rematch,
    leave: client.leave,
    reconnect: client.reconnect,
  };
}

export type GameSocket = ReturnType<typeof useGameSocket>;
