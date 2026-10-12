import type { Seat } from "@site/game-core";

/** The X or O glyph, drawn with the current text colour. Decorative: labels carry the meaning. */
export function Mark({ seat, className = "" }: { seat: Seat; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      {seat === "X" ? (
        <path
          d="M5.5 5.5l13 13M18.5 5.5l-13 13"
          stroke="currentColor"
          strokeWidth="2.75"
          strokeLinecap="round"
        />
      ) : (
        <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2.5" />
      )}
    </svg>
  );
}
