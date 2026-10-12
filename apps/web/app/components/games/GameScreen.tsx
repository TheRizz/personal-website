import { Eye, LogOut } from "lucide-react";
import { useNavigate } from "react-router";
import type { PublicState, Role } from "@site/game-core";
import type { ConnectionStatus } from "~/lib/games/client-state";
import { useGameSocket } from "~/lib/games/useGameSocket";
import { statusHeadline } from "~/lib/games/view";
import { ConnectionBadge, ConnectionNotice } from "./ConnectionBadge";
import { DisconnectNotice } from "./DisconnectNotice";
import { LobbyGonePanel } from "./LobbyGonePanel";
import { PlayerBar } from "./PlayerBar";
import { RematchControls } from "./RematchControls";
import { TicTacToeBoard } from "./TicTacToeBoard";
import { Toast } from "./Toast";
import { card, ghostButton, secondaryButton } from "./ui";
import { WaitingPanel } from "./WaitingPanel";

/** Everything below the page heading for one live lobby. */
export function GameScreen({ code, name }: { code: string; name: string }) {
  const game = useGameSocket(code, name);
  const navigate = useNavigate();

  function leave() {
    game.leave();
    navigate("/games/tictactoe");
  }

  if (game.connection === "notFound" || game.connection === "expired") {
    return <LobbyGonePanel expired={game.connection === "expired"} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <ConnectionBadge connection={game.connection} attempt={game.attempt} />
        <button type="button" onClick={leave} className={ghostButton}>
          <LogOut aria-hidden="true" />
          Leave game
        </button>
      </div>

      <ConnectionNotice connection={game.connection} onReconnect={game.reconnect} />

      {game.role === "spectator" && (
        <SpectatorBanner
          canTakeSeat={game.state?.phase === "waiting" && game.connection === "open"}
          onTakeSeat={game.reconnect}
        />
      )}

      {game.state && <DisconnectNotice state={game.state} role={game.role} />}

      {!game.state ? (
        <div className={`${card} flex min-h-64 items-center justify-center text-muted`}>
          {game.connection === "failed" ? "Couldn't connect to the game." : "Joining game…"}
        </div>
      ) : game.state.phase === "waiting" ? (
        <WaitingPanel code={code} spectating={game.role === "spectator"} />
      ) : (
        <Match
          state={game.state}
          role={game.role}
          connection={game.connection}
          pendingCell={game.pendingCell}
          onPlay={game.play}
          onRematch={game.rematch}
        />
      )}

      <Toast message={game.lastError} />
    </div>
  );
}

function SpectatorBanner({
  canTakeSeat,
  onTakeSeat,
}: {
  canTakeSeat: boolean;
  onTakeSeat: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <Eye aria-hidden="true" className="size-[18px] shrink-0 text-muted" />
      <p className="flex-1 text-[0.95rem]">
        <span className="font-semibold">You're watching.</span>{" "}
        <span className="text-muted">Both seats were taken when you arrived.</span>
      </p>
      {canTakeSeat && (
        <button
          type="button"
          onClick={onTakeSeat}
          className={`${secondaryButton} min-h-10 px-4 text-sm`}
        >
          Take the empty seat
        </button>
      )}
    </div>
  );
}

function Match({
  state,
  role,
  connection,
  pendingCell,
  onPlay,
  onRematch,
}: {
  state: PublicState;
  role: Role | null;
  connection: ConnectionStatus;
  pendingCell: number | null;
  onPlay: (cell: number) => void;
  onRematch: () => void;
}) {
  const headline = statusHeadline(state, role);
  const seat = role === "X" || role === "O" ? role : null;
  const connected = connection === "open";

  return (
    <div className="space-y-6">
      <PlayerBar state={state} role={role} />
      <p
        aria-live="polite"
        className={`text-center text-3xl leading-tight font-extrabold tracking-[-0.03em] sm:text-4xl ${
          headline.outcome === "lose" || (!headline.outcome && !(headline.yourMove && connected))
            ? "text-muted"
            : "text-fg"
        }`}
      >
        {headline.text}
      </p>
      <TicTacToeBoard
        board={state.board.board}
        result={state.result}
        mySeat={seat}
        canMove={connected && headline.yourMove && pendingCell === null}
        pendingCell={pendingCell}
        onPlay={onPlay}
        dimmed={!connected}
      />
      {state.phase === "finished" && (
        <RematchControls state={state} role={role} disabled={!connected} onRematch={onRematch} />
      )}
    </div>
  );
}
