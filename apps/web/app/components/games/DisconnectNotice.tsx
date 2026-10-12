import { WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { RECONNECT_GRACE_MS, SEATS, type PublicState, type Role, type Seat } from "@site/game-core";
import { formatCountdown } from "~/lib/games/client-state";
import { useNow } from "~/lib/games/useNow";
import { playerName } from "~/lib/games/view";

/** Each absent player other than `role`, with the time left on their held seat, ticking. */
function useAwaySeats(state: PublicState, role: Role | null): { seat: Seat; left: number }[] {
  const away = SEATS.filter((seat) => seat !== role && state.players[seat]?.releaseAt != null);
  const now = useNow(away.length > 0);
  return away.map((seat) => {
    const releaseAt = state.players[seat]?.releaseAt ?? 0;
    // Clamped to the grace period so a skewed local clock can't show nonsense.
    return { seat, left: Math.min(Math.max(releaseAt - now, 0), RECONNECT_GRACE_MS) };
  });
}

const icon = "shrink-0 text-amber-600 dark:text-amber-400";

/** "<name> disconnected — seat held for 1:42" for each absent player, while waiting. */
export function DisconnectNotice({ state, role }: { state: PublicState; role: Role | null }) {
  const away = useAwaySeats(state, role);
  if (away.length === 0) return null;

  return (
    <ul className="space-y-2">
      {away.map(({ seat, left }) => (
        <li
          key={seat}
          className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[0.95rem] text-fg"
        >
          <WifiOff aria-hidden="true" className={`size-[18px] ${icon}`} />
          <span>
            {playerName(state, seat)} disconnected — seat held for{" "}
            <span className="font-semibold tabular-nums">{formatCountdown(left)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The same, as one line that takes the place of `children` (the round and score line above the
 * board) while a player is away: it is on screen whenever the board is, and can't move the board.
 */
export function DisconnectStatus({
  state,
  role,
  className,
  children,
}: {
  state: PublicState;
  role: Role | null;
  className: string;
  children: ReactNode;
}) {
  const away = useAwaySeats(state, role);
  if (away.length === 0) return <p className={className}>{children}</p>;

  // Spectators can see both players away: count down to the first seat's release.
  const left = Math.min(...away.map((a) => a.left));
  const who = away.length === 1 ? playerName(state, away[0]!.seat) : "Both players";
  return (
    <p className={`${className} flex items-center justify-center whitespace-nowrap`}>
      <WifiOff aria-hidden="true" className={`mr-1.5 size-3.5 ${icon}`} />
      {/* A long name is cut short so the countdown stays on the one line. */}
      <span className="min-w-0 truncate text-fg">{who} disconnected</span>
      <span className="whitespace-pre text-fg">
        {` — ${away.length === 1 ? "seat" : "seats"} held for `}
        <span className="font-semibold tabular-nums">{formatCountdown(left)}</span>
      </span>
    </p>
  );
}
