import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { Mark } from "~/components/games/Marks";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games";

const DESCRIPTION =
  "Small games you can play with a friend, against the computer, or slowly, over many coffee breaks.";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Games", description: DESCRIPTION, path: "/games" });

const GAMES = [
  {
    to: "/games/tictactoe",
    title: "Tic-tac-toe",
    summary: "Three in a row wins. Start a game, send a friend the link and play in real time.",
    details: "2 players • In the browser • No sign-up",
    icon: "tictactoe",
  },
  {
    to: "/games/volley",
    title: "Power Volley",
    summary:
      "Arcade volleyball after Powa Volley Classic. Jump into the ball, win the serve, watch out for the monkey.",
    details: "1–2 players • 1v1 or 2v2 • Online 1v1 • Keyboard, gamepad or touch",
    icon: "volley",
  },
  {
    to: "/games/pipeline-tycoon",
    title: "Pipeline Tycoon",
    summary:
      "An idle tycoon about data pipelines. Start with an intern copy-pasting CSVs, end by integrating the planet.",
    details: "1 player • Idle / clicker • Saves to the server • Mouse, touch or keyboard",
    icon: "tycoon",
  },
] as const;

/** Nodes feeding a core, for the Pipeline Tycoon card. */
function TycoonIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="size-full text-fg" fill="none">
      <g stroke="currentColor" strokeOpacity="0.45" strokeWidth="2">
        <path d="M9 10 24 24M39 10 24 24M9 38l15-14M39 38 24 24" />
      </g>
      <circle cx="24" cy="24" r="7" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="24" cy="24" r="2.5" fill="currentColor" />
      {[
        [9, 10],
        [39, 10],
        [9, 38],
        [39, 38],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="3.5" stroke="currentColor" strokeWidth="2" />
      ))}
      <circle cx="16.5" cy="17" r="1.6" fill="currentColor" />
      <circle cx="31" cy="31" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** A volleyball by the net, for the Power Volley card. */
function VolleyIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="size-full text-fg" fill="none">
      <path d="M24 26v18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M20 26h8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M6 44h36"
        stroke="currentColor"
        strokeOpacity="0.5"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="15" cy="14" r="9" stroke="currentColor" strokeWidth="2.5" />
      <path
        d="M8 9.5c4 1 7.5 4 8.5 9.5M15 5c-1.5 4-1 8 2.5 11.5M24 13c-3.5 2.5-7.5 3-12 1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TicTacToeIcon() {
  return (
    <div className="grid size-full grid-cols-2 place-items-center gap-1">
      <Mark seat="X" className="size-full text-fg" />
      <Mark seat="O" className="size-full text-fg/80" />
      <Mark seat="O" className="size-full text-fg/80" />
      <Mark seat="X" className="size-full text-fg" />
    </div>
  );
}

export default function Games() {
  return (
    <>
      <PageHeading title="Games">{DESCRIPTION}</PageHeading>
      <ul className="flex flex-col gap-3">
        {GAMES.map((game) => (
          <li key={game.to}>
            <Link
              to={game.to}
              className="group -mx-4 flex items-center gap-5 rounded-xl px-4 py-3.5 transition duration-200 ease-spring hover:bg-surface active:scale-[0.995]"
            >
              <div
                aria-hidden="true"
                className="size-16 shrink-0 rounded-xl border border-line bg-surface p-2.5 sm:size-20"
              >
                {game.icon === "volley" ? (
                  <VolleyIcon />
                ) : game.icon === "tycoon" ? (
                  <TycoonIcon />
                ) : (
                  <TicTacToeIcon />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="mb-1.5 flex items-center gap-2 text-xl leading-snug font-bold tracking-tight decoration-underline decoration-1 underline-offset-4 transition duration-200 ease-spring group-hover:translate-x-0.5 group-hover:underline">
                  {game.title}
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 opacity-0 transition duration-200 ease-spring group-hover:translate-x-0.5 group-hover:opacity-70"
                  />
                </h2>
                <p className="mb-2 text-[0.92rem] leading-relaxed text-muted">{game.summary}</p>
                <p className="text-[0.8rem] tracking-[0.02em] text-muted">{game.details}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
