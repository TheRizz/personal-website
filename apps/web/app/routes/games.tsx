import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { PageHeading } from "~/components/PageHeading";
import { Mark } from "~/components/games/Marks";
import { pageMeta } from "~/lib/meta";
import type { Route } from "./+types/games";

const DESCRIPTION = "Small multiplayer games you can play with a friend.";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "Games", description: DESCRIPTION, path: "/games" });

const GAMES = [
  {
    to: "/games/tictactoe",
    title: "Tic-tac-toe",
    summary: "Three in a row wins. Start a game, send a friend the link and play in real time.",
    details: "2 players • In the browser • No sign-up",
  },
];

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
                className="grid size-16 shrink-0 grid-cols-2 place-items-center gap-1 rounded-xl border border-line bg-surface p-2.5 sm:size-20"
              >
                <Mark seat="X" className="size-full text-fg" />
                <Mark seat="O" className="size-full text-fg/80" />
                <Mark seat="O" className="size-full text-fg/80" />
                <Mark seat="X" className="size-full text-fg" />
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
