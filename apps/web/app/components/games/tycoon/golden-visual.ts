// How the golden packet is drawn and announced, as plain numbers so it can be tested without
// Phaser. The packet's schedule itself comes from @site/tycoon-core (ADR-0006).

/** Fading copies behind the packet, spaced along the path it has just flown. */
export const TRAIL_STEPS = 6;
const TRAIL_SPACING = 0.012;

/** Where the packet sits `progress` (0–1) through its flight across the scene. */
export function goldenPoint(
  progress: number,
  lane: number,
  width: number,
  top: number,
  area: number,
) {
  return {
    x: -20 + progress * (width + 40),
    y: top + area * (0.18 + lane * 0.64) + Math.sin(progress * Math.PI * 4) * 10,
  };
}

/** The trail's dots, nearest first; none before the packet has entered the scene. */
export function goldenTrail(progress: number): { progress: number; alpha: number }[] {
  const dots = [];
  for (let step = 1; step <= TRAIL_STEPS; step++) {
    const at = progress - step * TRAIL_SPACING;
    if (at < 0) break;
    dots.push({ progress: at, alpha: 0.55 * (1 - step / (TRAIL_STEPS + 1)) });
  }
  return dots;
}

/** How bright the trail is at `timeMs`: it pulses, unless motion is reduced. */
export function trailPulse(timeMs: number, still: boolean): number {
  return still ? 1 : 0.65 + 0.35 * Math.sin(timeMs / 150);
}

/** The ring's sweep in radians: a full circle on arrival, shrinking to nothing as time runs out. */
export function ringSweep(progress: number): number {
  return Math.min(1, Math.max(0, 1 - progress)) * Math.PI * 2;
}

/** Whole seconds left on screen, rounded up, for the spoken notice. */
export function secondsLeft(progress: number, visibleMs: number): number {
  return Math.max(0, Math.ceil(((1 - progress) * visibleMs) / 1000));
}

/** Notices each packet once as it arrives and once as it goes (caught or flown off). */
export class GoldenWatch {
  private shown: number | null = null;

  update(index: number | null): "arrived" | "left" | null {
    if (index === this.shown) return null;
    const previous = this.shown;
    this.shown = index;
    if (index !== null) return "arrived";
    return previous !== null ? "left" : null;
  }
}
