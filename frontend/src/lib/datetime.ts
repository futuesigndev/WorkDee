/**
 * Thai date/time rendering shared by the admin pages (task 027).
 *
 * The conventions are task 022's, lifted out of the records page so every page prints the same thing:
 * the **Buddhist Era** and **Asia/Bangkok** are both explicit, because the device's locale and time
 * zone must not change what HR reads. A bare `toLocaleString()` (what the Logs and LINE pages used)
 * printed the browser's own calendar and zone — `9/30/2026, 2:45:49 AM` on an en-US machine — and the
 * API keeps returning ISO strings, so the conversion belongs here and not in the response.
 *
 * Format: `dd/mm/yyyy HH:mm` (BE) for an instant, `dd/mm/yyyy` or `HH:mm` for one half of it.
 */
const BANGKOK = "Asia/Bangkok"

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** An instant as HR reads it: `30/09/2569 12:16` (Bangkok, Buddhist Era). `-` when there is no value. */
export function formatThaiDateTime(iso: string | null | undefined): string {
  const date = parse(iso)
  if (!date) return "-"
  return date.toLocaleString("th-TH", {
    timeZone: BANGKOK,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** The date half only (`30/09/2569`). */
export function formatThaiDate(iso: string | null | undefined): string {
  const date = parse(iso)
  if (!date) return "-"
  return date.toLocaleDateString("th-TH", {
    timeZone: BANGKOK,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

/** The time half only (`12:16`). */
export function formatThaiTime(iso: string | null | undefined): string {
  const date = parse(iso)
  if (!date) return "-"
  return date.toLocaleTimeString("th-TH", {
    timeZone: BANGKOK,
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * A plain `YYYY-MM-DD` day (a `work_date`, a date filter) as `dd/mm/yyyy` in the Buddhist Era. It is
 * pinned to UTC midnight and read in Bangkok so the calendar day never shifts.
 */
export function formatThaiDay(value: string | null | undefined): string {
  if (!value) return "-"
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("th-TH", {
    timeZone: BANGKOK,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

/**
 * The same day, written out with its weekday: `วันพุธที่ 30 กันยายน 2569` (task 029's history cards,
 * where the employee scans by day rather than by date). Pinned to UTC midnight and read in Bangkok like
 * `formatThaiDay`, so the weekday can never belong to the neighbouring day.
 */
export function formatThaiDayWithWeekday(value: string | null | undefined): string {
  if (!value) return "-"
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("th-TH", {
    timeZone: BANGKOK,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

/** A `YYYY-MM` month as `กันยายน 2569` — the history page's month switcher label. `-` when absent. */
export function formatThaiMonth(value: string | null | undefined): string {
  if (!value) return "-"
  const date = new Date(`${value}-01T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("th-TH", {
    timeZone: BANGKOK,
    month: "long",
    year: "numeric",
  })
}
