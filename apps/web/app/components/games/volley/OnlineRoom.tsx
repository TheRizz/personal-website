import { Check, LogOut, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { LobbyCode } from "~/components/games/LobbyCode";
import { LobbyGonePanel } from "~/components/games/LobbyGonePanel";
import { card, eyebrow, ghostButton, primaryButton, secondaryButton } from "~/components/games/ui";
import { socketUrl, volleyPath } from "~/lib/games/links";
import { loadToken, saveToken } from "~/lib/games/storage";
import { characterById } from "~/lib/games/volley/characters";
import { type Match } from "~/lib/games/volley/engine";
import { encodeInput, type RoomView, type Seat } from "~/lib/games/volley/net";
import { RoomConnection, type RoomState } from "~/lib/games/volley/online";
import { COURTS } from "~/lib/games/volley/setup";
import { Controls, GAME_KEYS } from "./controls";
import { CourtScreen, OverlayCard, barButton, fitCanvas } from "./CourtScreen";
import { drawMatch, rallyBanner } from "./render";
import { playEvent, unlockAudio } from "./sound";
import { CharacterPicker, MuteButton } from "./VolleyGame";

const MUTED_KEY = "games.volley.muted";
/** Corrections bigger than this (a new rally, the monkey's catch) are shown at once. */
const MAX_EASED_PX = 140;
/** How fast a correction fades out, in seconds. */
const EASE_S = 0.09;

const tokenKey = (code: string) => `volley.${code}`;

function loadMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean) {
  try {
    window.localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  } catch {
    // Not remembered; fine for this visit.
  }
}

/** One online room: the lobby where both players get ready, then the match full screen. */
export function OnlineRoom({
  code,
  name,
  character,
}: {
  code: string;
  name: string;
  character: string;
}) {
  const navigate = useNavigate();
  const [connection] = useState(
    () =>
      new RoomConnection(
        { name, character },
        {
          openSocket: () => new WebSocket(socketUrl(window.location, code, "volley")),
          loadToken: () => loadToken(tokenKey(code)),
          saveToken: (token) => saveToken(tokenKey(code), token),
          now: () => performance.now(),
        },
      ),
  );
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getState,
    connection.getState,
  );

  useEffect(() => {
    connection.start();
    return connection.stop;
  }, [connection]);

  function leave() {
    connection.leave();
    navigate("/games/volley");
  }

  if (state.status === "expired") return <LobbyGonePanel expired startPath="/games/volley" />;
  if (state.status === "full") {
    return <Notice text="This game is full: both players are in and 8 people are watching." />;
  }
  if (state.status === "replaced") {
    return (
      <Notice text="You opened this game somewhere else, so it moved there.">
        <button type="button" onClick={connection.retry} className={secondaryButton}>
          Watch here instead
        </button>
      </Notice>
    );
  }
  if (state.status === "offline" && !state.room) {
    return (
      <Notice text="Couldn't reach the game. Check your connection and try again.">
        <button type="button" onClick={connection.retry} className={secondaryButton}>
          Try again
        </button>
      </Notice>
    );
  }
  if (!state.room || !state.joined) return <Notice text="Joining game…" />;
  if (state.room.phase === "lobby") {
    return (
      <RoomLobby
        code={code}
        state={state}
        room={state.room}
        connection={connection}
        onLeave={leave}
      />
    );
  }
  return <OnlineMatch state={state} room={state.room} connection={connection} onLeave={leave} />;
}

function Notice({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className={`${card} flex min-h-64 flex-col items-center justify-center gap-4 text-center`}>
      <p className="max-w-[44ch] text-muted" role="status">
        {text}
      </p>
      {children}
    </div>
  );
}

/** A player's blob in their colour, as in the character picker. */
function Blob({ character }: { character: string }) {
  return (
    <svg viewBox="0 0 40 36" aria-hidden="true" className="h-7 w-8 shrink-0">
      <path
        d="M20 3C30 3 35 13 35 22C35 30 29 33 20 33C11 33 5 30 5 22C5 13 10 3 20 3Z"
        fill={characterById(character).color}
        stroke="#000"
        strokeWidth="2.5"
      />
      <circle cx="16" cy="14" r="2.2" fill="#000" />
      <circle cx="24" cy="14" r="2.2" fill="#000" />
    </svg>
  );
}

function ConnectionLine({ status }: { status: RoomState["status"] }) {
  if (status !== "reconnecting" && status !== "offline") return null;
  return (
    <p role="status" className="text-sm text-muted">
      {status === "reconnecting" ? "Connection lost. Reconnecting…" : "You're offline."}
    </p>
  );
}

function RoomLobby({
  code,
  state,
  room,
  connection,
  onLeave,
}: {
  code: string;
  state: RoomState;
  room: RoomView;
  connection: RoomConnection;
  onLeave: () => void;
}) {
  const seat = state.seat;
  const me = seat === null ? null : room.players[seat];
  const opponent = seat === null ? null : room.players[seat === 0 ? 1 : 0];
  const court = COURTS.find((entry) => entry.id === room.court)?.label ?? room.court;
  const waiting = seat !== null && !opponent;

  return (
    <div className="space-y-4">
      {waiting && (
        <section aria-label="Waiting for an opponent" className={`${card} py-8`}>
          <LobbyCode code={code} path={volleyPath} />
          <p className="mx-auto mt-6 max-w-[36ch] text-center text-sm text-muted">
            Send the link to a friend. Once you're both ready, the match starts.
          </p>
        </section>
      )}

      <section aria-labelledby="players-title" className={`${card} space-y-5`}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="players-title" className={eyebrow}>
            Players
          </h2>
          <p className="text-sm text-muted">
            {court} · first to {room.target}
          </p>
        </div>
        <ul className="space-y-3">
          {room.players.map((player, index) => (
            <li key={index} className="flex items-center gap-3">
              {player ? (
                <>
                  <Blob character={player.character} />
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {player.name}
                    {index === seat && <span className="font-normal text-muted"> (you)</span>}
                  </span>
                  <span className="text-sm text-muted">
                    {!player.connected ? (
                      "Away"
                    ) : player.ready ? (
                      <span className="inline-flex items-center gap-1 text-fg">
                        <Check aria-hidden="true" className="size-4" />
                        Ready
                      </span>
                    ) : (
                      "Getting ready"
                    )}
                  </span>
                </>
              ) : (
                <span className="text-muted">Waiting for a player…</span>
              )}
            </li>
          ))}
        </ul>
        {room.wins[0] + room.wins[1] > 0 && (
          <p className="text-sm text-muted">
            Matches won: {room.players[0]?.name ?? "P1"} {room.wins[0]},{" "}
            {room.players[1]?.name ?? "P2"} {room.wins[1]}
          </p>
        )}
        {seat === null && <p className="text-muted">You're watching this game.</p>}
      </section>

      {me && (
        <section className={`${card} space-y-5`}>
          <CharacterPicker
            legend="Your player"
            name="character"
            value={me.character}
            onChange={(id) => connection.pick(id)}
          />
          {state.error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {state.error}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              unlockAudio();
              connection.ready();
            }}
            disabled={me.ready}
            className={`${primaryButton} w-full`}
          >
            <Play aria-hidden="true" />
            {me.ready ? `Waiting for ${opponent?.name ?? "an opponent"}…` : "Ready"}
          </button>
          <p className="text-sm text-muted">
            Turn your phone sideways for a bigger court. Hit the ball by running and jumping into
            it; only the serving side scores.
          </p>
        </section>
      )}

      <div className="flex items-center justify-between gap-3">
        <ConnectionLine status={state.status} />
        <button type="button" onClick={onLeave} className={`${ghostButton} ml-auto`}>
          <LogOut aria-hidden="true" />
          Leave game
        </button>
      </div>
    </div>
  );
}

type Offset = { x: number; y: number };

/** Where the eased-out corrections are drawn from: each player and the ball. */
function positions(match: Match): Offset[] {
  return [...match.players.map((player) => ({ x: player.x, y: player.y })), match.ball];
}

function OnlineMatch({
  state,
  room,
  connection,
  onLeave,
}: {
  state: RoomState;
  room: RoomView;
  connection: RoomConnection;
  onLeave: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [muted, setMuted] = useState(loadMuted);
  const mutedRef = useRef(muted);
  const [controls] = useState(() => new Controls(1));
  const [announcement, setAnnouncement] = useState("");
  const [rtt, setRtt] = useState<number | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const latest = useRef({ state, room });
  const seat = state.seat;
  const names: [string, string] = [room.players[0]?.name ?? "P1", room.players[1]?.name ?? "P2"];
  const namesRef = useRef(names);

  useEffect(() => {
    latest.current = { state, room };
    namesRef.current = names;
    mutedRef.current = muted;
  });

  // The countdown and the "back in" times tick on screen.
  useEffect(() => {
    if (room.phase !== "countdown" && room.phase !== "paused") return;
    const timer = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(timer);
  }, [room.phase]);

  useEffect(() => {
    const element = canvas.current!;
    const area = stage.current!;
    const ctx = element.getContext("2d")!;
    let scale = 1;
    let frame = 0;
    let last = performance.now();
    let seenSnapshots = -1;
    let lastSnapshotFrame = -1;
    let lastSnapshotPhase = "";
    let heard = 0;
    let shown: { frame: number; at: Offset[] } | null = null;
    const offsets: Offset[] = [];
    let rttShownAt = 0;

    function tags(): string[] {
      const [a, b] = namesRef.current;
      return [a, b].map((name, index) => (index === seat ? "You" : name.slice(0, 10)));
    }

    function draw(match: Match | null) {
      if (!match) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, element.width, element.height);
        return;
      }
      drawMatch(ctx, match, scale, tags(), namesRef.current);
    }

    const observer = new ResizeObserver(() => {
      scale = fitCanvas(element, area);
    });
    observer.observe(area);

    function tick(time: number) {
      const dt = Math.min(0.1, (time - last) / 1000);
      last = time;
      const { predictor, clock } = connection;
      const snapshot = predictor.snapshot;
      const phase = latest.current.room.phase;
      if (!snapshot) {
        draw(null);
        frame = requestAnimationFrame(tick);
        return;
      }
      if (snapshot.frame < lastSnapshotFrame) heard = snapshot.frame; // a new match
      const playing = phase === "playing";
      const at = playing ? clock.advance(time, snapshot.frame) : snapshot.frame;
      if (seat !== null && (playing || phase === "countdown")) {
        connection.press(at, encodeInput(controls.read(0)));
      }

      if (connection.snapshots !== seenSnapshots) {
        seenSnapshots = connection.snapshots;
        lastSnapshotFrame = snapshot.frame;
        // The new snapshot may tell a different story about what was just shown: keep drawing
        // things where they were and ease them over to where they really are.
        if (shown && playing) {
          const fresh = predictor.predict(shown.frame);
          if (fresh) {
            positions(fresh).forEach((position, index) => {
              const before = shown!.at[index];
              const offset = (offsets[index] ??= { x: 0, y: 0 });
              if (!before) return;
              const dx = before.x - position.x;
              const dy = before.y - position.y;
              if (Math.hypot(dx, dy) > MAX_EASED_PX) {
                offset.x = 0;
                offset.y = 0;
              } else {
                offset.x += dx;
                offset.y += dy;
              }
            });
          }
        }
        // Rally results come from the room, not from the guess.
        const kind = snapshot.match.phase.kind;
        if (kind !== lastSnapshotPhase && kind === "point") {
          const banner = rallyBanner(snapshot.match, namesRef.current) ?? "";
          const [a, b] = snapshot.match.score;
          setAnnouncement(`${banner} ${a} to ${b}.`);
        }
        lastSnapshotPhase = kind;
      }

      const match = predictor.predict(at, (event, k) => {
        if (k >= heard && !mutedRef.current && event.type !== "win") playEvent(event);
      });
      heard = Math.max(heard, at);
      if (match) {
        shown = { frame: at, at: positions(match).map(({ x, y }) => ({ x, y })) };
        const fade = Math.exp(-dt / EASE_S);
        const targets = [...match.players, match.ball];
        offsets.forEach((offset, index) => {
          offset.x *= fade;
          offset.y *= fade;
          const target = targets[index];
          if (target) {
            target.x += offset.x;
            target.y += offset.y;
          }
        });
      }
      draw(match);
      if (time - rttShownAt > 1000) {
        rttShownAt = time;
        setRtt(playing ? Math.round(clock.rtt()) : null);
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);

    function onKeyDown(event: KeyboardEvent) {
      if (!GAME_KEYS.has(event.code)) return;
      event.preventDefault();
      controls.keyDown(event.code);
    }
    const onKeyUp = (event: KeyboardEvent) => controls.keyUp(event.code);
    const onBlur = () => controls.release();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      controls.release();
    };
  }, [connection, controls, seat]);

  function toggleMute() {
    unlockAudio();
    setMuted((value) => {
      saveMuted(!value);
      return !value;
    });
  }

  const opponentSeat: Seat | null = seat === null ? null : seat === 0 ? 1 : 0;
  const opponent = opponentSeat === null ? null : room.players[opponentSeat];
  const me = seat === null ? null : room.players[seat];
  const away = room.players.find((player) => player && !player.connected);
  const score = connection.predictor.snapshot?.match.score ?? [0, 0];
  const countdown =
    room.phase === "countdown" && state.startsAt !== null
      ? Math.max(1, Math.ceil((state.startsAt - now) / 1000))
      : null;

  let overlay = null;
  if (countdown !== null) {
    overlay = (
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center pt-[22vh]">
        <p
          className="text-8xl font-black text-[#ffd23f] [-webkit-text-stroke:3px_#1c2a6b]"
          aria-live="assertive"
        >
          {countdown}
        </p>
      </div>
    );
  } else if (room.phase === "paused") {
    overlay = (
      <OverlayCard title="Paused">
        {room.pausedFor === "idle" ? (
          <>
            <p className="text-muted">Nobody moved for a while.</p>
            {me && (
              <button type="button" onClick={connection.ready} className={primaryButton}>
                <Play aria-hidden="true" />
                Resume
              </button>
            )}
          </>
        ) : (
          <p className="text-muted">
            {away ? `Waiting for ${away.name} to come back` : "Waiting for both players"}…
          </p>
        )}
        <button type="button" onClick={onLeave} className={secondaryButton}>
          Leave game
        </button>
      </OverlayCard>
    );
  } else if (room.phase === "over" && room.winner !== null) {
    const [a, b] = score;
    const winner = room.winner === seat ? "You win" : `${names[room.winner]} wins`;
    overlay = (
      <OverlayCard title={`${winner} ${Math.max(a, b)}–${Math.min(a, b)}`}>
        {me && (
          <button
            type="button"
            onClick={connection.ready}
            disabled={me.ready}
            className={primaryButton}
          >
            <RotateCcw aria-hidden="true" />
            {me.ready ? `Waiting for ${opponent?.name ?? "your opponent"}…` : "Rematch"}
          </button>
        )}
        {opponent?.ready && !me?.ready && (
          <p className="text-sm text-muted">{opponent.name} wants a rematch.</p>
        )}
        <button type="button" onClick={onLeave} className={secondaryButton}>
          Leave game
        </button>
      </OverlayCard>
    );
  }

  return (
    <CourtScreen
      canvas={canvas}
      stage={stage}
      people={1}
      onTouch={(_, change) => controls.setTouch(0, change)}
      announcement={announcement}
      actions={
        <>
          <MuteButton muted={muted} onToggle={toggleMute} />
          <p className="text-xs text-white/60 tabular-nums" aria-live="off">
            {state.status === "reconnecting"
              ? "Reconnecting…"
              : rtt !== null
                ? `${rtt} ms`
                : seat === null
                  ? "Watching"
                  : ""}
          </p>
          <button type="button" onClick={onLeave} className={barButton} aria-label="Leave game">
            <X aria-hidden="true" />
          </button>
        </>
      }
      overlay={overlay}
    />
  );
}
