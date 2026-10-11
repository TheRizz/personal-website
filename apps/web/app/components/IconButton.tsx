import type { ReactNode } from "react";

/** Rounded pill that groups icon buttons in the header. */
export function IconGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-full border border-line bg-surface px-1 py-0.5 transition-colors hover:bg-surface-hover"
    >
      {children}
    </div>
  );
}

/** Shared look for the round icon buttons and links in the header. */
export const iconButtonClass =
  "flex items-center gap-1.5 rounded-full p-1.5 text-fg transition duration-200 ease-spring hover:-translate-y-0.5 hover:bg-surface-hover [&>svg]:opacity-80 hover:[&>svg]:opacity-100 active:translate-y-0 active:scale-95 [&_svg]:size-[18px]";
