import { useEffect, useState } from "react";
import { data, redirect } from "react-router";
import { isLobbyCode, MAX_SPECTATORS_PER_LOBBY } from "@site/game-core";
import { PageHeading } from "~/components/PageHeading";
import { GameScreen } from "~/components/games/GameScreen";
import { LobbyGonePanel } from "~/components/games/LobbyGonePanel";
import { NamePrompt } from "~/components/games/NamePrompt";
import { card, secondaryButton } from "~/components/games/ui";
import { lookupLobby, type LobbyLookup } from "~/lib/games/api";
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

  return (
    <>
      <PageHeading title="Tic-tac-toe">
        Game <span className="font-mono tracking-[0.08em] text-fg">{code}</span>
      </PageHeading>
      {savedName === undefined ? (
        // Server render: the name and the lobby are only known in the browser.
        <Placeholder text="Loading game…" />
      ) : savedName === null ? (
        <NamePrompt code={code} onSubmit={saveName} />
      ) : (
        <LobbyGate key={code} code={code} name={savedName} />
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

/** Checks the lobby exists before opening a socket, so a dead link gets a friendly page. */
function LobbyGate({ code, name }: { code: string; name: string }) {
  const [lookup, setLookup] = useState<LobbyLookup | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    lookupLobby(code, fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLookup(result);
    });
    return () => controller.abort();
  }, [code, tries]);

  const retry = () => {
    setLookup(null);
    setTries((n) => n + 1);
  };

  if (!lookup) return <Placeholder text="Finding game…" />;
  if (lookup.kind === "notFound") return <LobbyGonePanel />;
  if (lookup.kind === "error") {
    return (
      <RetryPanel
        text="Couldn't reach the game server. Check your connection and try again."
        onRetry={retry}
      />
    );
  }
  // A tab holding a seat token always tries: its seat is never refused.
  if (lookup.full && !loadToken(code)) {
    return (
      <RetryPanel
        text={`This game is full: both seats are taken and ${MAX_SPECTATORS_PER_LOBBY} people are watching. Try again in a little while.`}
        onRetry={retry}
      />
    );
  }
  return <GameScreen key={name} code={code} name={name} />;
}

function RetryPanel({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className={`${card} flex min-h-64 flex-col items-center justify-center gap-4 text-center`}>
      <p className="max-w-[44ch] text-muted" role="alert">
        {text}
      </p>
      <button type="button" className={secondaryButton} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
