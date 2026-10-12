/** Shared Tailwind classes for the game screens, matching the site's rounded-xl surfaces. */

const buttonBase =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-base font-semibold transition duration-200 ease-spring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[18px]";

/** Solid call to action (inverted colours). */
export const primaryButton = `${buttonBase} bg-fg text-bg hover:-translate-y-0.5 hover:opacity-90`;

/** Quiet button on a surface. */
export const secondaryButton = `${buttonBase} border border-line bg-surface text-fg hover:bg-surface-hover`;

/** Small text-only button, e.g. "Leave". */
export const ghostButton =
  "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-muted transition duration-200 ease-spring hover:bg-surface hover:text-fg active:scale-95 [&_svg]:size-4";

export const inputClass =
  "block w-full rounded-xl border border-line bg-surface px-4 py-3 text-base text-fg transition-colors placeholder:text-muted/70 hover:bg-surface-hover focus-visible:border-fg/40 aria-invalid:border-red-500/60";

/** Uppercase small-caps label, like the month headings on the blog. */
export const eyebrow = "text-[0.8rem] font-semibold tracking-[0.08em] text-muted uppercase";

export const card = "rounded-xl border border-line bg-surface p-5 sm:p-6";
