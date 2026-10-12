import { SEATS, type PublicState, type Role, type Seat } from "@site/game-core";
import { playerName } from "~/lib/games/view";
import { Mark } from "./Marks";

function PlayerCard({
  state,
  seat,
  label,
  active,
}: {
  state: PublicState;
  seat: Seat;
  label: string;
  active: boolean;
}) {
  const player = state.players[seat];
  const status = !player ? "empty seat" : player.connected ? "online" : "offline";
  return (
    <li
      className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 transition duration-300 ease-spring sm:gap-3 sm:px-4 sm:py-3 ${
        active ? "border-fg/40 bg-surface-hover" : "border-line bg-surface"
      }`}
    >
      <Mark seat={seat} className="hidden size-6 shrink-0 text-fg sm:block" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-[0.08em] text-muted uppercase">
          <Mark seat={seat} className="size-3.5 shrink-0 text-fg sm:hidden" />
          <span className="truncate">{label}</span>
          <span className="sr-only">
            {" "}
            ({seat}), {status}
            {active && ", to move"}
          </span>
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              player?.connected ? "bg-emerald-500" : player ? "bg-amber-500" : "bg-muted/50"
            }`}
          />
        </p>
        <p className="mt-1 truncate font-semibold text-fg">{playerName(state, seat)}</p>
      </div>
      <p className="shrink-0 text-2xl font-extrabold tracking-tight tabular-nums">
        <span className="sr-only">Score: </span>
        {state.score[seat]}
      </p>
    </li>
  );
}

/** Both players with their mark, score, connection dot and whose turn it is. */
export function PlayerBar({ state, role }: { state: PublicState; role: Role | null }) {
  const turn =
    state.phase === "playing" && state.result.kind === "playing" ? state.result.turn : null;
  return (
    <div>
      <ul aria-label="Players" className="grid grid-cols-2 gap-2 sm:gap-3">
        {SEATS.map((seat) => (
          <PlayerCard
            key={seat}
            state={state}
            seat={seat}
            label={role === seat ? "You" : "Player"}
            active={turn === seat}
          />
        ))}
      </ul>
      <p className="mt-2 text-center text-[0.8rem] tracking-[0.02em] text-muted">
        Round {state.round} • {state.score.draws} {state.score.draws === 1 ? "draw" : "draws"}
        {state.spectators > 0 && ` • ${state.spectators} watching`}
      </p>
    </div>
  );
}
