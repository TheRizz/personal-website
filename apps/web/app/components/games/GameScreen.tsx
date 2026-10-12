import { Eye, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { isSeat, type PublicState, type Role } from "@site/game-core";
import type { ConnectionStatus } from "~/lib/games/client-state";
import { focusIsLost } from "~/lib/games/focus";
import { useGameSocket } from "~/lib/games/useGameSocket";
import { announcement, statusHeadline } from "~/lib/games/view";
import { ConnectionBadge, ConnectionNotice } from "./ConnectionBadge";
import { DisconnectNotice } from "./DisconnectNotice";
import { LobbyGonePanel } from "./LobbyGonePanel";
import { PlayerBar } from "./PlayerBar";
import { RematchControls } from "./RematchControls";
import { TicTacToeBoard } from "./TicTacToeBoard";
import { Toast } from "./Toast";
import { card, ghostButton, secondaryButton } from "./ui";
import { WaitingPanel } from "./WaitingPanel";

/**
 * Everything below the page heading for one live lobby. `focusOnMount` is set when the player's
 * own action (Join game, Try again) put this screen in place of the focused button.
 */
export function GameScreen({
  code,
  name,
  focusOnMount = false,
}: {
  code: string;
  name: string;
  focusOnMount?: boolean;
}) {
  const game = useGameSocket(code, name);
  const navigate = useNavigate();
  const announced = useAnnouncement(game.state, game.role);
  const badge = useRef<HTMLSpanElement>(null);
  // Set when a button that goes away on success (Reconnect, Watch here, Take the empty seat, or the
  // one that mounted this screen) is pressed, so focus can land on the badge instead of <body>.
  const refocus = useRef(focusOnMount);

  function reconnect() {
    refocus.current = true;
    game.reconnect();
  }

  useEffect(() => {
    if (!refocus.current || game.connection === "connecting") return;
    refocus.current = false;
    if (focusIsLost()) badge.current?.focus();
  }, [game.connection]);

  function leave() {
    game.leave();
    navigate("/games/tictactoe");
  }

  if (game.connection === "notFound" || game.connection === "expired") {
    return <LobbyGonePanel expired={game.connection === "expired"} />;
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <p className="sr-only" aria-live="polite">
        {announced}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <ConnectionBadge
          ref={badge}
          connection={game.connection}
          attempt={game.attempt}
          lobbyFull={game.lobbyFull}
        />
        <button type="button" onClick={leave} className={ghostButton}>
          <LogOut aria-hidden="true" />
          Leave game
        </button>
      </div>

      <ConnectionNotice
        connection={game.connection}
        lobbyFull={game.lobbyFull}
        onReconnect={reconnect}
      />

      {game.role === "spectator" && (
        <SpectatorBanner
          canTakeSeat={game.state?.phase === "waiting" && game.connection === "open"}
          onTakeSeat={reconnect}
        />
      )}

      {!game.state ? (
        <div className={`${card} flex min-h-64 items-center justify-center text-muted`}>
          {game.connection !== "failed"
            ? "Joining game…"
            : game.lobbyFull
              ? "This game is full."
              : "Couldn't connect to the game."}
        </div>
      ) : game.state.phase === "waiting" ? (
        <>
          <DisconnectNotice state={game.state} role={game.role} />
          <WaitingPanel code={code} spectating={game.role === "spectator"} />
        </>
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

/** Scrolls `element` the least distance that shows all of it, unless it already is. */
function revealWhole(element: HTMLElement | null) {
  if (!element) return;
  const { top, bottom } = element.getBoundingClientRect();
  if (top >= 0 && bottom <= window.innerHeight) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

/** The latest screen-reader announcement for changes to the lobby (see `announcement`). */
function useAnnouncement(state: PublicState | null, role: Role | null): string {
  const [text, setText] = useState("");
  const previous = useRef<PublicState | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = state;
    const next = state && announcement(prev, state, role);
    if (next) setText(next);
  }, [state, role]);
  return text;
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
  const seat = isSeat(role) ? role : null;
  const connected = connection === "open";
  const boardRef = useRef<HTMLDivElement>(null);
  const rematchRef = useRef<HTMLDivElement>(null);
  const round = useRef(state.round);

  // Once the game starts, bring the whole board into view (on phones it starts below the fold).
  useEffect(() => revealWhole(boardRef.current), []);

  // When a round ends, and when a rematch request adds a line, keep "Play again" in view too.
  useEffect(() => {
    if (state.phase === "finished") revealWhole(rematchRef.current);
  }, [state.phase, state.rematch.X, state.rematch.O]);

  // A new round removes the rematch controls; keep keyboard focus on the board.
  useEffect(() => {
    if (state.round === round.current) return;
    round.current = state.round;
    if (focusIsLost()) boardRef.current?.querySelector("button")?.focus();
  }, [state.round]);

  return (
    <div className="space-y-4 sm:space-y-6">
      <PlayerBar state={state} role={role} />
      {/* Always two lines tall, so the board doesn't move when the text wraps on some turns. */}
      <p
        className={`flex min-h-[2lh] items-center justify-center text-center text-2xl leading-tight font-extrabold tracking-[-0.03em] text-balance sm:text-4xl ${
          headline.outcome === "lose" || (!headline.outcome && !(headline.yourMove && connected))
            ? "text-muted"
            : "text-fg"
        }`}
      >
        <span className="line-clamp-2 break-words">{headline.text}</span>
      </p>
      <div ref={boardRef}>
        <TicTacToeBoard
          board={state.board.board}
          result={state.result}
          mySeat={seat}
          canMove={connected && headline.yourMove && pendingCell === null}
          pendingCell={pendingCell}
          onPlay={onPlay}
          dimmed={!connected}
        />
      </div>
      {state.phase === "finished" && (
        <div ref={rematchRef}>
          <RematchControls state={state} role={role} disabled={!connected} onRematch={onRematch} />
        </div>
      )}
    </div>
  );
}
