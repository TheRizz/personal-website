import { describe, expect, it } from "vitest";
import { runBot } from "./bot";

// The pacing targets from docs/04-pipeline-tycoon.md §1, checked with a greedy bot that clicks
// 5 times a second, catches golden packets and migrates when it would at least quadruple its
// production bonus. If a balance change breaks these, retune before shipping.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("pacing", () => {
  const report = runBot({ clicksPerSecond: 5, migrateRatio: 4, limitMs: 8 * HOUR, stepMs: 10_000 });

  it("lets you buy something within 15 seconds", () => {
    // Fifteen records at 1 per click, five clicks a second.
    const quick = runBot({ clicksPerSecond: 5, migrateRatio: 4, limitMs: MINUTE, stepMs: 1_000 });
    expect(quick.firstPurchaseMs).not.toBeNull();
    expect(quick.firstPurchaseMs!).toBeLessThanOrEqual(15_000);
  });

  it("offers the first migration at about 45 minutes", () => {
    expect(report.firstMigrationAvailableMs).not.toBeNull();
    expect(report.firstMigrationAvailableMs!).toBeGreaterThan(30 * MINUTE);
    expect(report.firstMigrationAvailableMs!).toBeLessThan(75 * MINUTE);
  });

  it("reaches the ending in about 3 hours, after a handful of migrations", () => {
    expect(report.endingMs).not.toBeNull();
    expect(report.endingMs!).toBeGreaterThan(2 * HOUR);
    expect(report.endingMs!).toBeLessThan(5 * HOUR);
    expect(report.migrationTimesMs.length).toBeGreaterThanOrEqual(3);
    expect(report.migrationTimesMs.length).toBeLessThanOrEqual(7);
  });
});
