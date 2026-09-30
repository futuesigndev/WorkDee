/**
 * The date an employee reads on a news card and on an item (task 039): `30 ก.ย. 2569`.
 *
 * The shared `@/lib/datetime` helpers print `30/09/2569` (admin tables, where columns line up), while
 * the sheet asks for the short Thai month by name on these two screens — the same wording the history
 * page's month label uses (`กันยายน 2569`, `formatThaiMonth`). Rather than change a helper every other
 * page depends on, the two news screens share this one: same conventions as `lib/datetime.ts`
 * (**Buddhist Era** and **Asia/Bangkok** are both explicit, so neither the device's calendar nor its
 * time zone can change what the employee sees), only a different shape.
 */
const BANGKOK = "Asia/Bangkok"

export function formatNewsDate(iso: string | null | undefined): string {
  if (!iso) return "-"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("th-TH", {
    timeZone: BANGKOK,
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}
