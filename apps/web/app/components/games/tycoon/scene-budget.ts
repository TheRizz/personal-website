// How much the factory scene draws at once. A late game owns every tier and taps fast, which
// used to mean up to 400 packets (each two 100-segment circles, re-triangulated every frame) and
// a new text texture per tap. These caps keep a phone's frame time flat however far you get.

/** Packets on screen at once, across every tier. */
export const PACKET_CAP = 150;
/** "+N" numbers floating up from the core at once; a new tap reuses the oldest. */
export const FLOAT_CAP = 6;
/** Purchase and catch rings at once; Buy Max on ten tiers doesn't stack ten more. */
export const BURST_CAP = 8;

/** Packets per second for one tier: grows with the log of production so the screen stays readable. */
export function packetsPerSecond(rate: number, boosted: boolean): number {
  return Math.min(14, 0.6 + Math.log10(rate * (boosted ? 7 : 1) + 1) * 1.4);
}

/**
 * The share of the packet cap one tier may hold, so the cheap tiers (drawn first) can't crowd
 * the expensive ones out of the picture.
 */
export function tierCap(ownedTiers: number, cap = PACKET_CAP): number {
  return ownedTiers <= 0 ? 0 : Math.floor(cap / ownedTiers);
}

/**
 * Adds this frame's share to a tier's spawn debt and says how many packets to start now. Debt
 * never builds up past one packet while the tier is full, so a full screen doesn't release a
 * flood the moment room appears.
 */
export function spawnPackets(
  debt: number,
  perSecond: number,
  dt: number,
  live: number,
  cap: number,
): { spawn: number; debt: number } {
  let next = debt + perSecond * dt;
  const room = Math.max(0, cap - live);
  const spawn = Math.min(Math.floor(next), room);
  next -= spawn;
  return { spawn, debt: room > spawn ? next : Math.min(next, 1) };
}

/** Index of the slot a new item takes in a ring of `cap` slots: a free one, else the oldest. */
export function pickSlot(ages: readonly (number | null)[]): number {
  let oldest = 0;
  for (let i = 0; i < ages.length; i++) {
    const age = ages[i];
    if (age === null || age === undefined) return i;
    if (age > (ages[oldest] ?? -1)) oldest = i;
  }
  return oldest;
}

/**
 * Corners for a circle of this radius. Phaser draws every circle as 100 corners and cuts it
 * into triangles again each frame; a few dozen look the same at these sizes.
 */
export function circleSegments(radius: number): number {
  return Math.max(12, Math.min(48, Math.ceil(radius * 0.75)));
}

export interface Point {
  x: number;
  y: number;
}

const unitCircles = new Map<number, Point[]>();
const scratch = new Map<number, Point[]>();

/**
 * The corners of a circle, in an array reused between calls with the same corner count (use it
 * before asking for the next circle).
 */
export function circlePoints(x: number, y: number, radius: number): Point[] {
  const segments = circleSegments(radius);
  let unit = unitCircles.get(segments);
  let out = scratch.get(segments);
  if (!unit || !out) {
    unit = Array.from({ length: segments }, (_, i) => {
      const angle = (i / segments) * Math.PI * 2;
      return { x: Math.cos(angle), y: Math.sin(angle) };
    });
    out = unit.map(() => ({ x: 0, y: 0 }));
    unitCircles.set(segments, unit);
    scratch.set(segments, out);
  }
  for (let i = 0; i < segments; i++) {
    out[i]!.x = x + unit[i]!.x * radius;
    out[i]!.y = y + unit[i]!.y * radius;
  }
  return out;
}
