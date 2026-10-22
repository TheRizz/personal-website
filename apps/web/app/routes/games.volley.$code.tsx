import { useEffect, useState, useSyncExternalStore } from "react";
import { data, redirect } from "react-router";
import { isLobbyCode } from "@site/game-core";
import { PageHeading } from "~/components/PageHeading";
import { LobbyGonePanel } from "~/components/games/LobbyGonePanel";
import { NamePrompt } from "~/components/games/NamePrompt";
import { card, secondaryButton } from "~/components/games/ui";
import { OnlineRoom } from "~/components/games/volley/OnlineRoom";
import { lookupVolleyRoom, type LobbyLookup } from "~/lib/games/api";
import { volleyPath } from "~/lib/games/links";
import { saveName, useSavedName } from "~/lib/games/storage";
import { parseSetup } from "~/lib/games/volley/setup";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games.volley.$code";

/** A typed-in lowercase link goes to the canonical code; anything else malformed is a 404. */
function checkCode(code: string) {
  const upper = code.toUpperCase();
  if (!isLobbyCode(upper)) throw data(null, { status: 404 });
  if (upper !== code) throw redirect(volleyPath(upper));
  return { code };
}

export function loader({ params }: Route.LoaderArgs) {
  return checkCode(params.code);
}

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return checkCode(params.code);
}

export const meta: Route.MetaFunction = ({ params }) => [
  ...pageMeta({
    title: "Power Volley game",
    description: "You've been invited to a game of Power Volley.",
    path: volleyPath(params.code),
  }),
  { name: "robots", content: "noindex" },
];

const subscribeNothing = () => () => {};

/** The character picked last time on the setup screen ("games.volley.setup"). */
function savedCharacter(): string {
  try {
    return parseSetup(JSON.parse(window.localStorage.getItem("games.volley.setup") ?? "null")).p1;
  } catch {
    return parseSetup(null).p1;
  }
}

export default function VolleyRoomPage({ loaderData: { code } }: Route.ComponentProps) {
  const savedName = useSavedName();
  const character = useSyncExternalStore(subscribeNothing, savedCharacter, () => null);

  return (
    <>
      <PageHeading title="Power Volley" compact>
        Online game <span className="font-mono tracking-[0.08em] text-fg">{code}</span>
      </PageHeading>
      {savedName === undefined || character === null ? (
        <div
          className={`${card} flex min-h-64 items-center justify-center text-muted`}
          role="status"
        >
          Loading game…
        </div>
      ) : savedName === null ? (
        <NamePrompt code={code} game="Power Volley" onSubmit={saveName} />
      ) : (
        <RoomGate key={`${code}:${savedName}`} code={code} name={savedName} character={character} />
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

/** Checks the room exists before connecting, so a dead link gets a friendly page. */
function RoomGate({ code, name, character }: { code: string; name: string; character: string }) {
  const [lookup, setLookup] = useState<LobbyLookup | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    lookupVolleyRoom(code, fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLookup(result);
    });
    return () => controller.abort();
  }, [code, tries]);

  if (!lookup) return <Placeholder text="Finding game…" />;
  if (lookup.kind === "notFound") return <LobbyGonePanel startPath="/games/volley" />;
  if (lookup.kind === "error") {
    return (
      <div
        className={`${card} flex min-h-64 flex-col items-center justify-center gap-4 text-center`}
      >
        <p className="max-w-[44ch] text-muted" role="alert">
          Couldn't reach the game server. Check your connection and try again.
        </p>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            setLookup(null);
            setTries((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return <OnlineRoom code={code} name={name} character={character} />;
}
