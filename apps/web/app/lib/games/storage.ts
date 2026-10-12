import { useSyncExternalStore } from "react";
import { displayNameSchema } from "@site/game-core";

// Storage can be unavailable (private mode, blocked cookies); every access falls back quietly.

const NAME_KEY = "games.name";
const tokenKey = (code: string) => `games.token.${code}`;

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Not persisted; the value still works for this page view.
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

/** The seat token for a lobby. Per tab (sessionStorage), so a refresh keeps the same seat. */
export const loadToken = (code: string) => read(session, tokenKey(code));
export const saveToken = (code: string, token: string | null) =>
  write(session, tokenKey(code), token);

const nameListeners = new Set<() => void>();
// Kept in memory too, so a name entered while storage is blocked still sticks for this visit.
let memoryName: string | null = null;

function readSavedName(): string | null {
  const parsed = displayNameSchema.safeParse(read(local, NAME_KEY) ?? memoryName ?? "");
  return parsed.success ? parsed.data : null;
}

/** Remembers the display name in localStorage ("games.name"). */
export function saveName(name: string): void {
  memoryName = name;
  write(local, NAME_KEY, name);
  for (const listener of nameListeners) listener();
}

function subscribeName(listener: () => void) {
  nameListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    nameListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * The saved display name: undefined while rendering on the server (not known yet), null if none
 * is saved or it is no longer valid.
 */
export function useSavedName(): string | null | undefined {
  return useSyncExternalStore(subscribeName, readSavedName, () => undefined);
}
