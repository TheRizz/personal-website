import { GENERATORS } from "@site/tycoon-core";

// Where the factory scene draws things, as plain numbers so it can be tested without Phaser.

/** The strip along the top edge kept clear for the counter laid over it (TycoonGame). */
export const TOP_INSET = 64;
/** A node label's two lines of 11 px text, which sit on the side away from the core. */
export const LABEL_W = 40;
export const LABEL_H = 28;
const LABEL_GAP = 5;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function factoryLayout(width: number, height: number) {
  const top = TOP_INSET;
  const area = height - top;
  const cx = width / 2;
  const cy = top + area / 2;
  // Nodes shrink on a short phone scene so ten of them fit round the core without touching.
  const nodeMax = Math.min(21, Math.max(12, Math.min(width, area) * 0.085));
  const rx = Math.max(60, width / 2 - nodeMax - LABEL_W - 8);
  const ry = Math.max(44, area / 2 - nodeMax - LABEL_H - 6);
  const coreRadius = Math.max(32, Math.min(width, area) * 0.12);
  const nodes = GENERATORS.map((_, tier) => {
    // Spread the ten tiers around the core, starting at the top-left and going clockwise. No
    // tier sits straight above or below the core, where a short phone scene has least room.
    const angle = -Math.PI * 0.8 + (tier / GENERATORS.length) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, angle };
  });
  return { width, height, top, area, cx, cy, coreRadius, nodeMax, nodes };
}

export type FactoryLayout = ReturnType<typeof factoryLayout>;

/** A node's radius: it grows with the number owned, up to the layout's largest. */
export function nodeRadius(layout: FactoryLayout, owned: number): number {
  return (layout.nodeMax / 21) * (9 + Math.min(12, Math.log2(owned + 1) * 1.6));
}

/**
 * Where a node's label goes: outward from the core (below the bottom nodes, beside the side ones,
 * above the top ones), so it never lands on a neighbouring node. `origin` is Phaser's text origin.
 */
export function labelPlacement(layout: FactoryLayout, tier: number, radius: number) {
  const node = layout.nodes[tier]!;
  const cos = Math.cos(node.angle);
  const sin = Math.sin(node.angle);
  const origin = { x: 0.5 - cos * 0.5, y: 0.5 - sin * 0.5 };
  const x = node.x + cos * (radius + LABEL_GAP);
  const y = node.y + sin * (radius + LABEL_GAP);
  const box: Box = {
    left: x - origin.x * LABEL_W,
    top: y - origin.y * LABEL_H,
    right: x + (1 - origin.x) * LABEL_W,
    bottom: y + (1 - origin.y) * LABEL_H,
  };
  return { x, y, origin, box };
}
