import { useSyncExternalStore } from "react";
import { NOTATIONS, formatNumber, type Notation } from "@site/tycoon-core";

// The settings sheet's choices, kept in this browser's localStorage (not in the save, so the CLI
// and other devices keep their own). Sound keeps the key it had before the sheet existed.

export interface TycoonSettings {
  sound: boolean;
  notation: Notation;
  /** Calmer scene: no pulsing, spinning, bursts or rising numbers. */
  reduceMotion: boolean;
}

const SOUND_KEY = "games.tycoon.sound";
const SETTINGS_KEY = "games.tycoon.settings";

/** What the server render and a browser without storage use. */
export const DEFAULT_SETTINGS: TycoonSettings = {
  sound: false,
  notation: "short",
  reduceMotion: false,
};

let current: TycoonSettings | null = null;
const listeners = new Set<() => void>();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function load(): TycoonSettings {
  let sound = false;
  let saved: Partial<Record<keyof TycoonSettings, unknown>> = {};
  try {
    sound = window.localStorage.getItem(SOUND_KEY) === "on";
    saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    // Storage blocked or garbled; defaults for this visit.
  }
  return {
    sound,
    notation: NOTATIONS.includes(saved.notation as Notation)
      ? (saved.notation as Notation)
      : "short",
    // Until it's been set here, follow the device's own reduce-motion setting.
    reduceMotion:
      typeof saved.reduceMotion === "boolean" ? saved.reduceMotion : prefersReducedMotion(),
  };
}

export function getSettings(): TycoonSettings {
  return (current ??= load());
}

export function updateSettings(change: Partial<TycoonSettings>) {
  const next = { ...getSettings(), ...change };
  current = next;
  try {
    window.localStorage.setItem(SOUND_KEY, next.sound ? "on" : "off");
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ notation: next.notation, reduceMotion: next.reduceMotion }),
    );
  } catch {
    // Not remembered; fine for this visit.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): TycoonSettings {
  return useSyncExternalStore(subscribe, getSettings, () => DEFAULT_SETTINGS);
}

/** Formats a number in the notation picked in settings. */
export function useFormat(): (value: number) => string {
  const { notation } = useSettings();
  return (value) => formatNumber(value, notation);
}
