/** Content dates are plain YYYY-MM-DD strings; format them in UTC so they never shift a day. */
const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);

const shortDay = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/** "Sun • Oct 11" */
export function formatShortDate(iso: string): string {
  const parts = Object.fromEntries(
    shortDay.formatToParts(parse(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} • ${parts.month} ${parts.day}`;
}

/** "October 11, 2026" */
export function formatLongDate(iso: string): string {
  return longDate.format(parse(iso));
}

export interface YearGroup<T> {
  year: string;
  months: { month: string; items: T[] }[];
}

/** Groups items (already sorted newest first) by year, then month, keeping their order. */
export function groupByYearAndMonth<T extends { date: string }>(items: T[]): YearGroup<T>[] {
  const years: YearGroup<T>[] = [];
  for (const item of items) {
    const year = item.date.slice(0, 4);
    const month = monthName.format(parse(item.date));
    let yearGroup = years.at(-1);
    if (yearGroup?.year !== year) {
      yearGroup = { year, months: [] };
      years.push(yearGroup);
    }
    let monthGroup = yearGroup.months.at(-1);
    if (monthGroup?.month !== month) {
      monthGroup = { month, items: [] };
      yearGroup.months.push(monthGroup);
    }
    monthGroup.items.push(item);
  }
  return years;
}
