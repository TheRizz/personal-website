import type { ReactNode } from "react";

/**
 * The page title and its one-line description. `compact` (for screens that need the room, like a
 * game) puts the description beside the title from `sm` up and leaves less space below.
 */
export function PageHeading({
  title,
  children,
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "mb-6 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-5" : "mb-10"}>
      <h1 className="text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">{title}</h1>
      {children && (
        <p className={compact ? "mt-3 text-muted sm:mt-0" : "mt-3 text-muted"}>{children}</p>
      )}
    </div>
  );
}
