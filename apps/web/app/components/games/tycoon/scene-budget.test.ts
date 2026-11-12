import { describe, expect, it } from "vitest";
import {
  BURST_CAP,
  circlePoints,
  circleSegments,
  FLOAT_CAP,
  PACKET_CAP,
  packetsPerSecond,
  pickSlot,
  spawnPackets,
  tierCap,
} from "./scene-budget";

describe("packetsPerSecond", () => {
  it("starts gentle and tops out at 14 a second", () => {
    expect(packetsPerSecond(0, false)).toBeCloseTo(0.6);
    expect(packetsPerSecond(1e30, false)).toBe(14);
    expect(packetsPerSecond(100, true)).toBeGreaterThan(packetsPerSecond(100, false));
  });
});

describe("tierCap", () => {
  it("splits the cap between the tiers on screen", () => {
    expect(tierCap(1)).toBe(PACKET_CAP);
    expect(tierCap(10)).toBe(Math.floor(PACKET_CAP / 10));
    expect(tierCap(0)).toBe(0);
  });
});

describe("spawnPackets", () => {
  it("spawns whole packets as the debt builds up", () => {
    expect(spawnPackets(0.5, 10, 0.1, 0, 20)).toEqual({ spawn: 1, debt: 0.5 });
    expect(spawnPackets(0, 2, 0.1, 0, 20)).toEqual({ spawn: 0, debt: 0.2 });
  });

  it("never goes past the tier's cap and doesn't save up a flood while full", () => {
    let debt = 0;
    let live = 0;
    for (let frame = 0; frame < 600; frame++) {
      const step = spawnPackets(debt, 14, 1 / 60, live, 15);
      debt = step.debt;
      live += step.spawn;
      expect(live).toBeLessThanOrEqual(15);
      expect(debt).toBeLessThanOrEqual(1);
    }
    expect(live).toBe(15);
    // Room for five more: at most one is waiting, the rest come at the normal rate.
    expect(spawnPackets(debt, 14, 1 / 60, 10, 15).spawn).toBeLessThanOrEqual(1);
  });

  it("whole late game: ten tiers at full rate for a minute stay under the total cap", () => {
    const cap = tierCap(10);
    const live = Array.from({ length: 10 }, () => [] as number[]);
    const debts = live.map(() => 0);
    const dt = 1 / 60;
    let most = 0;
    for (let frame = 0; frame < 3600; frame++) {
      live.forEach((packets, tier) => {
        const step = spawnPackets(debts[tier]!, 14, dt, packets.length, cap);
        debts[tier] = step.debt;
        for (let i = 0; i < step.spawn; i++) packets.push(0);
        // Packets take about 1.6 s to reach the core.
        for (let i = 0; i < packets.length; i++) packets[i]! += dt / 1.6;
        live[tier] = packets.filter((progress) => progress < 1);
      });
      most = Math.max(
        most,
        live.reduce((sum, packets) => sum + packets.length, 0),
      );
    }
    expect(most).toBeLessThanOrEqual(PACKET_CAP);
    // Every tier still shows a steady stream.
    for (const packets of live) expect(packets.length).toBeGreaterThan(5);
  });
});

describe("pickSlot", () => {
  it("takes a free slot first, else the oldest", () => {
    expect(pickSlot([0.2, null, 0.5])).toBe(1);
    expect(pickSlot([0.2, 0.9, 0.5])).toBe(1);
    expect(pickSlot([])).toBe(0);
  });

  it("small caps for floats and rings", () => {
    expect(FLOAT_CAP).toBeLessThanOrEqual(8);
    expect(BURST_CAP).toBeLessThanOrEqual(10);
  });
});

describe("circlePoints", () => {
  it("uses fewer corners for small circles, never under 12 or over 48", () => {
    expect(circleSegments(2)).toBe(12);
    expect(circleSegments(40)).toBe(30);
    expect(circleSegments(500)).toBe(48);
  });

  it("puts every corner on the circle", () => {
    const points = circlePoints(100, 50, 20);
    expect(points).toHaveLength(circleSegments(20));
    for (const point of points) {
      expect(Math.hypot(point.x - 100, point.y - 50)).toBeCloseTo(20);
    }
    expect(points[0]).toEqual({ x: 120, y: 50 });
  });

  it("reuses its array so a frame of circles makes no garbage", () => {
    const first = circlePoints(0, 0, 20);
    const second = circlePoints(10, 10, 20);
    expect(second).toBe(first);
    expect(second[0]).toEqual({ x: 30, y: 10 });
  });
});
