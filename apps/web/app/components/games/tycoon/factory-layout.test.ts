import { describe, expect, it } from "vitest";
import { GENERATORS } from "@site/tycoon-core";
import { factoryLayout, labelPlacement, nodeRadius, type Box } from "./factory-layout";

// Scene sizes: an iPhone with Safari's toolbars showing, the same phone at full height, and a
// laptop's left column.
const SIZES = [
  { name: "phone in Safari", width: 372, height: 246 },
  { name: "phone, full height", width: 372, height: 315 },
  { name: "laptop", width: 1000, height: 638 },
];
/** Owned at the top of a long run: every node at its largest. */
const MANY = 10_000;

function overlaps(a: Box, b: Box) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function circleBox(x: number, y: number, r: number): Box {
  return { left: x - r, top: y - r, right: x + r, bottom: y + r };
}

describe.each(SIZES)("factoryLayout on a $name", ({ width, height }) => {
  const layout = factoryLayout(width, height);
  const radius = nodeRadius(layout, MANY);
  const tiers = GENERATORS.map((_, tier) => tier);

  it("keeps every label off every other node and label", () => {
    for (const tier of tiers) {
      const label = labelPlacement(layout, tier, radius).box;
      for (const other of tiers.filter((t) => t !== tier)) {
        const node = layout.nodes[other]!;
        expect(overlaps(label, circleBox(node.x, node.y, radius)), `${tier} on node ${other}`).toBe(
          false,
        );
        expect(
          overlaps(label, labelPlacement(layout, other, radius).box),
          `${tier} on label ${other}`,
        ).toBe(false);
      }
    }
  });

  it("keeps nodes apart and clear of the core", () => {
    for (const tier of tiers) {
      const node = layout.nodes[tier]!;
      expect(Math.hypot(node.x - layout.cx, node.y - layout.cy)).toBeGreaterThan(
        layout.coreRadius + radius,
      );
      for (const other of tiers.filter((t) => t > tier)) {
        const next = layout.nodes[other]!;
        expect(Math.hypot(node.x - next.x, node.y - next.y)).toBeGreaterThan(radius * 2);
      }
    }
  });

  it("keeps labels inside the scene and below the counter strip", () => {
    for (const tier of tiers) {
      const { box } = labelPlacement(layout, tier, radius);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.top).toBeGreaterThanOrEqual(layout.top);
      expect(box.bottom).toBeLessThanOrEqual(height);
    }
  });
});
