import type { KeyboardEvent } from "react";
import type { GameStatus, Seat, TicTacToeCell } from "@site/game-core";
import { cellLabel } from "~/lib/games/view";
import { Mark } from "./Marks";

const ARROW_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -3,
  ArrowDown: 3,
};

/** Moves focus between cells with the arrow keys (Tab still works too). */
function onArrowKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  const step = ARROW_STEPS[event.key];
  if (step === undefined) return;
  const target = index + step;
  const sameRow = Math.abs(step) === 3 || Math.floor(target / 3) === Math.floor(index / 3);
  if (target < 0 || target > 8 || !sameRow) return;
  event.preventDefault();
  const cells = event.currentTarget.parentElement?.querySelectorAll("button");
  cells?.[target]?.focus();
}

/** Losing marks fade once the round is over; an unconfirmed move is translucent; O is a touch softer. */
function markOpacity(value: Seat, winning: boolean, over: boolean, pending: boolean): string {
  if (pending) return "opacity-60";
  if (winning) return "";
  if (over) return "opacity-30";
  return value === "O" ? "opacity-80" : "";
}

/**
 * The 3x3 board as real buttons. Cells stay focusable when it isn't your move (aria-disabled), so
 * keyboard focus isn't lost when the turn passes.
 */
export function TicTacToeBoard({
  board,
  result,
  mySeat,
  canMove,
  pendingCell,
  onPlay,
  dimmed = false,
}: {
  board: TicTacToeCell[];
  result: GameStatus;
  /** Your seat, for the hover preview; null for spectators. */
  mySeat: Seat | null;
  canMove: boolean;
  pendingCell: number | null;
  onPlay: (cell: number) => void;
  /** Faded out while disconnected. */
  dimmed?: boolean;
}) {
  const winLine = result.kind === "won" ? (result.line ?? []) : [];
  const over = result.kind !== "playing";

  return (
    <div
      role="group"
      aria-label="Tic-tac-toe board"
      className={`mx-auto grid w-full max-w-[22rem] grid-cols-3 gap-2 transition-opacity duration-300 sm:gap-2.5 ${
        dimmed ? "opacity-50" : ""
      }`}
    >
      {board.map((value, index) => {
        const playable = canMove && value === null;
        const winning = winLine.includes(index);
        return (
          <button
            // The board always has the same 9 cells in the same order.
            key={index}
            type="button"
            aria-label={cellLabel(index, value)}
            aria-disabled={!playable}
            onClick={() => playable && onPlay(index)}
            onKeyDown={(event) => onArrowKey(event, index)}
            className={`group relative flex aspect-square items-center justify-center rounded-xl border transition duration-200 ease-spring ${
              winning ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg"
            } ${playable ? "cursor-pointer hover:bg-surface-hover active:scale-[0.97]" : "cursor-default"}`}
          >
            {value ? (
              <Mark
                seat={value}
                className={`size-[58%] transition duration-300 ease-spring starting:scale-50 starting:opacity-0 ${markOpacity(
                  value,
                  winning,
                  over,
                  pendingCell === index,
                )}`}
              />
            ) : (
              playable &&
              mySeat && (
                <Mark
                  seat={mySeat}
                  className="size-[58%] text-fg opacity-0 transition-opacity duration-200 group-hover:opacity-20 group-focus-visible:opacity-20"
                />
              )
            )}
          </button>
        );
      })}
    </div>
  );
}
