import { LobbyCode } from "./LobbyCode";
import { card } from "./ui";

/** Shown while a seat is empty: the code to share and a waiting indicator. */
export function WaitingPanel({ code, spectating }: { code: string; spectating: boolean }) {
  return (
    <section aria-label="Waiting for an opponent" className={`${card} py-8 sm:py-10`}>
      <LobbyCode code={code} />
      <p className="mt-8 flex items-center justify-center gap-2.5 text-muted">
        <span className="relative flex size-2.5" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-fg/40" />
          <span className="relative inline-flex size-2.5 rounded-full bg-fg/70" />
        </span>
        {spectating ? "Waiting for a player to join…" : "Waiting for an opponent…"}
      </p>
      {!spectating && (
        <p className="mx-auto mt-2 max-w-[34ch] text-center text-sm text-muted">
          Send the link to a friend. The game starts as soon as they join.
        </p>
      )}
    </section>
  );
}
