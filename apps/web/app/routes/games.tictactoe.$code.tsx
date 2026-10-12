import { useEffect, useRef, useState } from "react";
import { data, redirect } from "react-router";
import { isLobbyCode, MAX_SPECTATORS_PER_LOBBY } from "@site/game-core";
import { PageHeading } from "~/components/PageHeading";
import { GameScreen } from "~/components/games/GameScreen";
import { LobbyGonePanel } from "~/components/games/LobbyGonePanel";
import { NamePrompt } from "~/components/games/NamePrompt";
import { card, secondaryButton } from "~/components/games/ui";
import { lookupLobby, type LobbyLookup } from "~/lib/games/api";
import { focusIsLost } from "~/lib/games/focus";
import { lobbyPath } from "~/lib/games/links";
import { loadToken, saveName, useSavedName } from "~/lib/games/storage";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games.tictactoe.$code";

/** A typed-in lowercase link goes to the canonical code; anything else malformed is a 404. */
function checkCode(code: string) {
  const upper = code.toUpperCase();
  if (!isLobbyCode(upper)) throw data(null, { status: 404 });
  if (upper !== code) throw redirect(lobbyPath(upper));
  return { code };
}

/** Malformed codes are a real 404 when the Worker renders the page. */
export function loader({ params }: Route.LoaderArgs) {
  return checkCode(params.code);
}

/** Same check on client-side navigation, without a round trip to the server. */
export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return checkCode(params.code);
}

export const meta: Route.MetaFunction = ({ params }) => [
  ...pageMeta({
    title: "Tic-tac-toe game",
    description: "You've been invited to a game of tic-tac-toe.",
    path: lobbyPath(params.code),
  }),
  { name: "robots", content: "noindex" },
];

export default function TicTacToeGame({ loaderData: { code } }: Route.ComponentProps) {
  const savedName = useSavedName();
  // "Join game" replaces the form, and the button with it: focus follows to what comes next.
  const [joining, setJoining] = useState(false);

  return (
    <>
      <PageHeading title="Tic-tac-toe" compact>
        Game <span className="font-mono tracking-[0.08em] text-fg">{code}</span>
      </PageHeading>
      {savedName === undefined ? (
        // Server render: the name and the lobby are only known in the browser.
        <Placeholder text="Loading game…" />
      ) : savedName === null ? (
        <NamePrompt
          code={code}
          onSubmit={(name) => {
            setJoining(true);
            saveName(name);
          }}
        />
      ) : (
        <LobbyGate key={code} code={code} name={savedName} focusOnMount={joining} />
      )}
    </>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className={`${card} flex min-h-64 items-center justify-center text-muted`} role="status">
      {text}
    </div>
  );
}

/**
 * Checks the lobby exists before opening a socket, so a dead link gets a friendly page.
 * `focusOnMount`: the player's own action put this in place of the focused button.
 */
function LobbyGate({
  code,
  name,
  focusOnMount,
}: {
  code: string;
  name: string;
  focusOnMount: boolean;
}) {
  const [lookup, setLookup] = useState<LobbyLookup | null>(null);
  const [tries, setTries] = useState(0);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    lookupLobby(code, fetch, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLookup(result);
      setChecking(false);
    });
    return () => controller.abort();
  }, [code, tries]);

  // The panel (and its focused button) stays up while checking again.
  const retry = () => {
    if (checking) return;
    setChecking(true);
    setTries((n) => n + 1);
  };

  if (!lookup) return <Placeholder text="Finding game…" />;
  if (lookup.kind === "notFound") return <LobbyGonePanel />;
  if (lookup.kind === "error") {
    return (
      <RetryPanel
        text="Couldn't reach the game server. Check your connection and try again."
        checking={checking}
        onRetry={retry}
        focusOnMount={focusOnMount}
      />
    );
  }
  // A tab holding a seat token always tries: its seat is never refused.
  if (lookup.full && !loadToken(code)) {
    return (
      <RetryPanel
        text={`This game is full: both seats are taken and ${MAX_SPECTATORS_PER_LOBBY} people are watching. Try again in a little while.`}
        checking={checking}
        onRetry={retry}
        focusOnMount={focusOnMount}
      />
    );
  }
  return <GameScreen key={name} code={code} name={name} focusOnMount={focusOnMount || tries > 0} />;
}

function RetryPanel({
  text,
  checking,
  onRetry,
  focusOnMount,
}: {
  text: string;
  checking: boolean;
  onRetry: () => void;
  focusOnMount: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusOnMount && focusIsLost()) button.current?.focus();
  }, [focusOnMount]);

  return (
    <div className={`${card} flex min-h-64 flex-col items-center justify-center gap-4 text-center`}>
      <p className="max-w-[44ch] text-muted" role="alert">
        {text}
      </p>
      {/* aria-disabled rather than disabled, which would drop keyboard focus. */}
      <button
        ref={button}
        type="button"
        className={`${secondaryButton} aria-disabled:opacity-50`}
        onClick={onRetry}
        aria-disabled={checking}
      >
        {checking ? "Checking…" : "Try again"}
      </button>
    </div>
  );
}
