import { WifiOff } from "lucide-react";
import { RECONNECT_GRACE_MS, SEATS, type PublicState, type Role } from "@site/game-core";
import { formatCountdown } from "~/lib/games/client-state";
import { useNow } from "~/lib/games/useNow";
import { playerName } from "~/lib/games/view";

/** "<name> disconnected — seat held for 1:42", ticking every second, for each absent player. */
export function DisconnectNotice({ state, role }: { state: PublicState; role: Role | null }) {
  const away = SEATS.filter((seat) => seat !== role && state.players[seat]?.releaseAt != null);
  const now = useNow(away.length > 0);
  if (away.length === 0) return null;

  return (
    <ul className="space-y-2">
      {away.map((seat) => {
        const releaseAt = state.players[seat]?.releaseAt ?? 0;
        // Clamped to the grace period so a skewed local clock can't show nonsense.
        const left = Math.min(Math.max(releaseAt - now, 0), RECONNECT_GRACE_MS);
        return (
          <li
            key={seat}
            className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[0.95rem] text-fg"
          >
            <WifiOff
              aria-hidden="true"
              className="size-[18px] shrink-0 text-amber-600 dark:text-amber-400"
            />
            <span>
              {playerName(state, seat)} disconnected — seat held for{" "}
              <span className="font-semibold tabular-nums">{formatCountdown(left)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
