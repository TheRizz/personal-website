import { Link } from "react-router";
import { card, primaryButton } from "./ui";

/** Friendly dead end for an unknown or expired lobby, with a way to start over. */
export function LobbyGonePanel({ expired = false }: { expired?: boolean }) {
  return (
    <section className={`${card} text-center`} aria-labelledby="lobby-gone-title">
      <h2 id="lobby-gone-title" className="text-2xl leading-tight font-bold tracking-tight">
        {expired ? "This game has expired" : "Lobby not found or expired"}
      </h2>
      <p className="mx-auto mt-2 max-w-[40ch] text-muted">
        {expired
          ? "Nobody played for a while, so the game was closed."
          : "Check the code, or start a new game and send your friend the link."}
      </p>
      <Link to="/games/tictactoe" className={`${primaryButton} mt-6`}>
        Start a new game
      </Link>
    </section>
  );
}
