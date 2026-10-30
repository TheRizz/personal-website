import { describe, expect, it } from "vitest";
import {
  GoldenWatch,
  TRAIL_STEPS,
  goldenPoint,
  goldenTrail,
  ringSweep,
  secondsLeft,
  trailPulse,
} from "./golden-visual";

describe("goldenPoint", () => {
  it("flies from just off the left edge to just off the right", () => {
    expect(goldenPoint(0, 0.5, 390, 64, 256).x).toBe(-20);
    expect(goldenPoint(1, 0.5, 390, 64, 256).x).toBe(410);
  });

  it("stays inside the scene below the counter strip in every lane", () => {
    for (const lane of [0, 0.5, 1]) {
      for (let progress = 0; progress <= 1; progress += 0.05) {
        const { y } = goldenPoint(progress, lane, 390, 64, 256);
        expect(y).toBeGreaterThan(64);
        expect(y).toBeLessThan(64 + 256);
      }
    }
  });
});

describe("goldenTrail", () => {
  it("has no dots before the packet has flown anywhere", () => {
    expect(goldenTrail(0)).toEqual([]);
  });

  it("follows behind the packet and fades with distance", () => {
    const dots = goldenTrail(0.5);
    expect(dots).toHaveLength(TRAIL_STEPS);
    for (let i = 1; i < dots.length; i++) {
      expect(dots[i]!.progress).toBeLessThan(dots[i - 1]!.progress);
      expect(dots[i]!.alpha).toBeLessThan(dots[i - 1]!.alpha);
    }
    expect(dots[0]!.progress).toBeLessThan(0.5);
    expect(dots.at(-1)!.alpha).toBeGreaterThan(0);
  });

  it("grows as the packet enters", () => {
    expect(goldenTrail(0.03).length).toBeLessThan(TRAIL_STEPS);
    expect(goldenTrail(0.03).length).toBeGreaterThan(0);
  });
});

describe("trailPulse", () => {
  it("holds still with reduced motion", () => {
    expect(trailPulse(0, true)).toBe(1);
    expect(trailPulse(1234, true)).toBe(1);
  });

  it("pulses otherwise, never fully dark", () => {
    const values = Array.from({ length: 50 }, (_, i) => trailPulse(i * 37, false));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.3);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.3);
  });
});

describe("ringSweep", () => {
  it("is a full circle on arrival and empty when time is up", () => {
    expect(ringSweep(0)).toBeCloseTo(Math.PI * 2);
    expect(ringSweep(0.5)).toBeCloseTo(Math.PI);
    expect(ringSweep(1)).toBe(0);
    expect(ringSweep(1.2)).toBe(0);
  });
});

describe("secondsLeft", () => {
  it("rounds up so a packet never says 0 while it's still there", () => {
    expect(secondsLeft(0, 12_000)).toBe(12);
    expect(secondsLeft(0.99, 12_000)).toBe(1);
    expect(secondsLeft(1, 12_000)).toBe(0);
  });
});

describe("GoldenWatch", () => {
  it("notices each packet once as it arrives and once as it goes", () => {
    const watch = new GoldenWatch();
    expect(watch.update(null)).toBeNull();
    expect(watch.update(0)).toBe("arrived");
    expect(watch.update(0)).toBeNull();
    expect(watch.update(null)).toBe("left");
    expect(watch.update(null)).toBeNull();
    expect(watch.update(1)).toBe("arrived");
  });

  it("counts a new packet straight after another as an arrival", () => {
    const watch = new GoldenWatch();
    watch.update(2);
    expect(watch.update(3)).toBe("arrived");
  });
});
