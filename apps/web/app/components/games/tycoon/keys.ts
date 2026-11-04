import { upcomingGolden, type GameState } from "@site/tycoon-core";

// Keyboard play on the web, kept close to the CLI's keys (packages/pipeline-tycoon-cli/src/app.ts):
// space on the core, 1–0 to build, x for the buy amount, arrows for the shop tabs, g to catch a
// golden packet, ? for the list. Only the core takes space and Enter, so buttons and the page keep
// theirs; the rest work anywhere on the page outside a text field or an open dialog.

export type KeyAction =
  | { type: "click" }
  | { type: "build"; tier: number }
  | { type: "amount" }
  | { type: "tab"; step: 1 | -1 }
  | { type: "golden" }
  | { type: "help" };

/** The parts of a KeyboardEvent the mapping looks at. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Space and Enter only count on the core itself. */
  onScene: boolean;
}

export function keyAction(press: KeyPress): KeyAction | null {
  // Browser and system shortcuts (cmd+1 switches browser tabs, ctrl+r reloads) stay theirs.
  if (press.ctrlKey || press.metaKey || press.altKey) return null;
  const { key } = press;
  if (key === " " || key === "Enter") return press.onScene ? { type: "click" } : null;
  const digit = "1234567890".indexOf(key);
  if (key.length === 1 && digit >= 0) return { type: "build", tier: digit };
  switch (key) {
    case "x":
    case "X":
      return { type: "amount" };
    case "ArrowRight":
      return { type: "tab", step: 1 };
    case "ArrowLeft":
      return { type: "tab", step: -1 };
    case "g":
    case "G":
      return { type: "golden" };
    case "?":
      return { type: "help" };
    default:
      return null;
  }
}

/** True when focus is somewhere typing belongs, so letters and digits go there instead. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLInputElement> | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range", "reset", "submit"].includes(element.type ?? "");
}

/** The golden packet on screen right now, if any (what `g` catches). */
export function goldenOnScreen(state: GameState): number | null {
  const spawn = upcomingGolden(state.golden, state.playMs);
  return state.playMs >= spawn.at && state.playMs <= spawn.at + spawn.visibleMs
    ? spawn.index
    : null;
}

/** The list `?` opens. `range` reads "1 to 0" rather than two separate keys. */
export const KEY_HELP: { keys: string[]; range?: boolean; does: string }[] = [
  { keys: ["Space"], does: "Process records (factory focused)" },
  { keys: ["1", "0"], range: true, does: "Build the matching generator" },
  { keys: ["X"], does: "Change how many each build buys" },
  { keys: ["←", "→"], does: "Switch shop tabs" },
  { keys: ["G"], does: "Catch the golden packet" },
  { keys: ["?"], does: "Show these keys" },
];
