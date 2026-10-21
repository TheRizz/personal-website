import type { Input } from "~/lib/games/volley/engine";

// Keyboard, gamepad and on-screen touch input for up to two people on one device.

interface KeyMap {
  left: string[];
  right: string[];
  jump: string[];
}

/** One person: arrows or WASD, jump also on Space. Two people: WASD and the arrows. */
const SOLO: KeyMap = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  jump: ["ArrowUp", "KeyW", "Space"],
};
const DUO: [KeyMap, KeyMap] = [
  { left: ["KeyA"], right: ["KeyD"], jump: ["KeyW", "Space"] },
  { left: ["ArrowLeft"], right: ["ArrowRight"], jump: ["ArrowUp"] },
];

export const GAME_KEYS = new Set([...SOLO.left, ...SOLO.right, ...SOLO.jump]);

const STICK_DEADZONE = 0.35;

export class Controls {
  private readonly keys = new Set<string>();
  /** Held on-screen buttons. */
  private readonly touch: [Input, Input] = [
    { left: false, right: false, jump: false },
    { left: false, right: false, jump: false },
  ];
  private startHeld = false;

  constructor(private readonly people: 1 | 2) {}

  keyDown(code: string) {
    this.keys.add(code);
  }

  keyUp(code: string) {
    this.keys.delete(code);
  }

  /** Called by the on-screen buttons as they're pressed and let go. */
  setTouch(person: 0 | 1, change: Partial<Input>) {
    Object.assign(this.touch[person], change);
  }

  /** Lets go of everything, e.g. when the window loses focus. */
  release() {
    this.keys.clear();
    for (const input of this.touch)
      Object.assign(input, { left: false, right: false, jump: false });
  }

  /** Person 0 or 1's input right now, from every source. */
  read(person: 0 | 1): Input {
    const map = this.people === 1 ? SOLO : DUO[person];
    const held = (codes: string[]) => codes.some((code) => this.keys.has(code));
    const touch = this.touch[person];
    const pad = gamepads()[person];
    return {
      left: held(map.left) || touch.left || (pad?.left ?? false),
      right: held(map.right) || touch.right || (pad?.right ?? false),
      jump: held(map.jump) || touch.jump || (pad?.jump ?? false),
    };
  }

  /** True once per press of Start on any gamepad. */
  startPressed(): boolean {
    const held = gamepads().some((pad) => pad.start);
    const pressed = held && !this.startHeld;
    this.startHeld = held;
    return pressed;
  }
}

interface PadState extends Input {
  start: boolean;
}

/** Connected gamepads in the standard layout: stick or d-pad to move, A or d-pad up to jump. */
function gamepads(): PadState[] {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
  const pads: PadState[] = [];
  for (const pad of navigator.getGamepads()) {
    if (!pad) continue;
    const pressed = (index: number) => pad.buttons[index]?.pressed ?? false;
    const x = pad.axes[0] ?? 0;
    pads.push({
      left: x < -STICK_DEADZONE || pressed(14),
      right: x > STICK_DEADZONE || pressed(15),
      jump: pressed(0) || pressed(12),
      start: pressed(9),
    });
  }
  return pads;
}
