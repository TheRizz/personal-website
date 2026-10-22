import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { COURT_H, COURT_W, type Input } from "~/lib/games/volley/engine";
import { ghostButton } from "~/components/games/ui";
import { TouchControls } from "./TouchControls";

/** Whether the device's main pointer is a finger. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(pointer: coarse)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}

/** Sizes the canvas to the largest 16:9 court that fits `area`. Returns court units to pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, area: HTMLElement): number {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.min(area.clientWidth, (area.clientHeight * COURT_W) / COURT_H);
  canvas.style.width = `${Math.floor(width)}px`;
  canvas.style.height = `${Math.floor((width * COURT_H) / COURT_W)}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(((width * COURT_H) / COURT_W) * ratio);
  return canvas.width / COURT_W;
}

/** The style for the small buttons in the bar above the court. */
export const barButton = `${ghostButton} text-white/80 hover:bg-white/10 hover:text-white`;

export function OverlayCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-xs rounded-xl border border-line bg-bg p-5 text-center text-fg shadow-xl"
      >
        <h2 className="mb-4 text-2xl font-extrabold tracking-tight">{title}</h2>
        <div className="flex flex-col gap-2.5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The full-screen court: a bar of buttons, the canvas, on-screen buttons on touch devices (at the
 * sides in landscape, below in portrait) and whatever overlays the match shows.
 */
export function CourtScreen({
  canvas,
  stage,
  people,
  onTouch,
  actions,
  overlay,
  announcement,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  stage: RefObject<HTMLDivElement | null>;
  people: 1 | 2;
  onTouch: (person: 0 | 1, change: Partial<Input>) => void;
  /** The buttons in the bar above the court. */
  actions: ReactNode;
  overlay?: ReactNode;
  /** Read out by screen readers. */
  announcement: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  const [touched, setTouched] = useState(false);
  const touch = coarse || touched;

  // Phones and tablets get on-screen buttons; so does anyone who touches the screen.
  useEffect(() => {
    const onTouch = () => setTouched(true);
    window.addEventListener("touchstart", onTouch, { once: true, passive: true });
    return () => window.removeEventListener("touchstart", onTouch);
  }, []);

  // The page behind the full-screen court shouldn't scroll. On iPhones, holding a button must not
  // start a text selection (with its copy menu) anywhere on the page, which CSS alone doesn't stop:
  // touches on the court and the buttons cancel the browser's own touch handling. Pointer events,
  // which the buttons use, still arrive.
  useEffect(() => {
    const html = document.documentElement;
    const locked = {
      overflow: "hidden",
      "user-select": "none",
      "-webkit-user-select": "none",
      "-webkit-touch-callout": "none",
    };
    const previous = Object.keys(locked).map((name) => [name, html.style.getPropertyValue(name)]);
    for (const [name, value] of Object.entries(locked)) html.style.setProperty(name, value);
    window.getSelection()?.removeAllRanges();

    const element = root.current!;
    const cancel = (event: Event) => event.preventDefault();
    const cancelGameTouch = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-game-touch]")) {
        event.preventDefault();
      }
    };
    document.addEventListener("selectstart", cancel);
    element.addEventListener("contextmenu", cancel);
    element.addEventListener("touchstart", cancelGameTouch, { passive: false });
    element.addEventListener("touchmove", cancelGameTouch, { passive: false });
    return () => {
      for (const [name, value] of previous) html.style.setProperty(name!, value!);
      document.removeEventListener("selectstart", cancel);
      element.removeEventListener("contextmenu", cancel);
      element.removeEventListener("touchstart", cancelGameTouch);
      element.removeEventListener("touchmove", cancelGameTouch);
    };
  }, []);

  const touchControls = (edge: "left" | "right") => (
    <TouchControls people={people} edge={edge} onChange={onTouch} />
  );

  return (
    <div
      ref={root}
      className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white select-none [-webkit-touch-callout:none]"
      data-testid="volley-match"
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-3">{actions}</div>

      <div className="relative flex min-h-0 flex-1 flex-col landscape:flex-row">
        {touch && (
          <div className="hidden w-32 shrink-0 flex-col items-center justify-end pb-4 pl-[env(safe-area-inset-left)] landscape:flex">
            {touchControls("left")}
          </div>
        )}
        <div ref={stage} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <canvas
            ref={canvas}
            role="img"
            aria-label="Volleyball court"
            data-game-touch
            className="touch-none rounded-lg"
          />
        </div>
        {touch && (
          <div className="hidden w-32 shrink-0 flex-col items-center justify-end pr-[env(safe-area-inset-right)] pb-4 landscape:flex">
            {touchControls("right")}
          </div>
        )}
        {touch && (
          <div className="flex shrink-0 items-end justify-between px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] landscape:hidden">
            {touchControls("left")}
            {touchControls("right")}
          </div>
        )}
        {overlay}
      </div>
      <p aria-live="polite" className="sr-only" data-testid="volley-announcer">
        {announcement}
      </p>
    </div>
  );
}
