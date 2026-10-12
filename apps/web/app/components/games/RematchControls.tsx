import { RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { isSeat, otherSeat, SEATS, type PublicState, type Role } from "@site/game-core";
import { playerName } from "~/lib/games/view";
import { primaryButton } from "./ui";

/** After a round: "Play again", or who is waiting on whom. */
export function RematchControls({
  state,
  role,
  disabled,
  onRematch,
}: {
  state: PublicState;
  role: Role | null;
  disabled: boolean;
  onRematch: () => void;
}) {
  const waitingText = useRef<HTMLParagraphElement>(null);
  const pressed = useRef(false);
  const asked = isSeat(role) && state.rematch[role];

  // "Play again" is replaced by the waiting text: move focus there rather than to <body>.
  useEffect(() => {
    if (asked && pressed.current) waitingText.current?.focus();
    pressed.current = false;
  }, [asked]);

  if (!isSeat(role)) {
    const [asker] = SEATS.filter((seat) => state.rematch[seat]);
    return (
      <p className="text-center text-muted">
        {asker
          ? `${playerName(state, asker)} wants a rematch`
          : "Waiting for the players to start a rematch"}
      </p>
    );
  }

  const opponent = playerName(state, otherSeat(role));
  if (asked) {
    return (
      <p ref={waitingText} tabIndex={-1} className="text-center text-muted" role="status">
        Waiting for {opponent} to accept…
      </p>
    );
  }
  const theyAsked = state.rematch[otherSeat(role)];
  return (
    <div className="flex flex-col items-center gap-3">
      {theyAsked && (
        <p className="text-center font-semibold text-fg" role="status">
          {opponent} wants a rematch
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          pressed.current = true;
          onRematch();
        }}
        disabled={disabled}
        className={primaryButton}
      >
        <RotateCcw />
        Play again
      </button>
    </div>
  );
}
