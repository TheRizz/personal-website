import { ChevronLeft, ChevronRight, ChevronsUp } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import type { Input } from "~/lib/games/volley/engine";

// On-screen buttons for phones and tablets. Each control tracks its own pointers, so several
// thumbs (two people on one phone) work at once, and a thumb can slide from left to right.

/** Reports which of a person's buttons are held. */
type Hold = (change: Partial<Input>) => void;

const surface =
  "flex touch-none items-center justify-center rounded-full border-2 border-white/40 bg-slate-900/35 text-white backdrop-blur-sm select-none [-webkit-touch-callout:none]";

function MovePad({ onChange, label }: { onChange: Hold; label: string }) {
  const pointers = useRef(new Map<number, -1 | 1>());
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);

  function sync() {
    const held = [...pointers.current.values()];
    const left = held.includes(-1);
    const right = held.includes(1);
    onChange({ left, right });
    setDirection(right && !left ? 1 : left && !right ? -1 : 0);
  }

  function track(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    pointers.current.set(event.pointerId, event.clientX < box.left + box.width / 2 ? -1 : 1);
    sync();
  }

  function release(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    sync();
  }

  return (
    <div
      role="group"
      aria-label={`${label} move`}
      className={`${surface} h-20 w-44 justify-between px-2 landscape:h-16 landscape:w-28 landscape:px-0.5`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        track(event);
      }}
      onPointerMove={(event) => pointers.current.has(event.pointerId) && track(event)}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ChevronLeft
        aria-hidden="true"
        className={`size-12 transition-opacity ${direction === -1 ? "opacity-100" : "opacity-60"}`}
      />
      <ChevronRight
        aria-hidden="true"
        className={`size-12 transition-opacity ${direction === 1 ? "opacity-100" : "opacity-60"}`}
      />
    </div>
  );
}

function JumpButton({ onChange, label }: { onChange: Hold; label: string }) {
  const pointers = useRef(new Set<number>());
  const [held, setHeld] = useState(false);

  function sync() {
    const jump = pointers.current.size > 0;
    onChange({ jump });
    setHeld(jump);
  }

  return (
    <div
      role="button"
      aria-label={`${label} jump`}
      aria-pressed={held}
      className={`${surface} size-20 transition-transform landscape:size-18 ${held ? "scale-95 bg-slate-900/55" : ""}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.add(event.pointerId);
        sync();
      }}
      onPointerUp={(event) => {
        pointers.current.delete(event.pointerId);
        sync();
      }}
      onPointerCancel={(event) => {
        pointers.current.delete(event.pointerId);
        sync();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ChevronsUp aria-hidden="true" className="size-10" />
    </div>
  );
}

/**
 * The buttons at one edge of the screen. One person: move on the left, jump on the right. Two
 * people: each gets move and jump at their own edge, player 1 on the left.
 */
export function TouchControls({
  onChange,
  people,
  edge,
}: {
  onChange: (person: 0 | 1, change: Partial<Input>) => void;
  people: 1 | 2;
  edge: "left" | "right";
}) {
  const person = people === 2 && edge === "right" ? 1 : 0;
  const hold: Hold = (change) => onChange(person, change);
  const label = people === 1 ? "Player" : `P${person + 1}`;
  if (people === 1) {
    return edge === "left" ? (
      <MovePad onChange={hold} label={label} />
    ) : (
      <JumpButton onChange={hold} label={label} />
    );
  }
  return (
    <div
      className={`flex flex-col gap-3 ${edge === "left" ? "items-start landscape:items-center" : "items-end landscape:items-center"}`}
    >
      <JumpButton onChange={hold} label={label} />
      <MovePad onChange={hold} label={label} />
    </div>
  );
}
