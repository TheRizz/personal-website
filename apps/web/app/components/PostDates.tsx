import { formatLongDate } from "~/lib/dates";

/** "October 11, 2026 • Updated October 14, 2026"; the updated date shows only when it differs. */
export function PostDates({ date, updated }: { date: string; updated?: string }) {
  return (
    <>
      <time dateTime={date}>{formatLongDate(date)}</time>
      {updated && updated !== date && (
        <>
          {" "}
          • Updated <time dateTime={updated}>{formatLongDate(updated)}</time>
        </>
      )}
    </>
  );
}
