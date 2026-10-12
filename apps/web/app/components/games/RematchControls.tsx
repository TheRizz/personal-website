import { RotateCcw } from "lucide-react";
import { otherSeat, type PublicState, type Role } from "@site/game-core";
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
  if (role !== "X" && role !== "O") {
    const asked = (["X", "O"] as const).filter((seat) => state.rematch[seat]);
    return (
      <p className="text-center text-muted">
        {asked[0]
          ? `${playerName(state, asked[0])} wants a rematch`
          : "Waiting for the players to start a rematch"}
      </p>
    );
  }

  const opponent = playerName(state, otherSeat(role));
  if (state.rematch[role]) {
    return (
      <p className="text-center text-muted" role="status">
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
      <button type="button" onClick={onRematch} disabled={disabled} className={primaryButton}>
        <RotateCcw />
        Play again
      </button>
    </div>
  );
}
