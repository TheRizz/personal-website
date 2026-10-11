import { describe, expect, it } from "vitest";
import { formatLongDate, formatShortDate, groupByYearAndMonth } from "./dates";

describe("formatShortDate", () => {
  it("formats weekday, month and day without shifting time zones", () => {
    expect(formatShortDate("2026-10-11")).toBe("Sun • Oct 11");
    expect(formatShortDate("2026-01-01")).toBe("Thu • Jan 1");
  });
});

describe("formatLongDate", () => {
  it("formats a full date", () => {
    expect(formatLongDate("2026-10-11")).toBe("October 11, 2026");
  });
});

describe("groupByYearAndMonth", () => {
  it("groups newest-first items by year then month", () => {
    const items = [
      { date: "2026-10-05" },
      { date: "2026-09-28" },
      { date: "2026-09-16" },
      { date: "2025-12-31" },
    ];
    expect(groupByYearAndMonth(items)).toEqual([
      {
        year: "2026",
        months: [
          { month: "October", items: [items[0]] },
          { month: "September", items: [items[1], items[2]] },
        ],
      },
      { year: "2025", months: [{ month: "December", items: [items[3]] }] },
    ]);
  });

  it("returns nothing for no items", () => {
    expect(groupByYearAndMonth([])).toEqual([]);
  });
});
