/**
 * Thai labels for attendance codes, shared by the HR pages (task 056).
 *
 * The records page (`dashboard/operation/attendance-records/page.tsx`) has shown these since task 022 and the
 * new HR dashboard shows the same flags, so the map moved here verbatim instead of being copied: two screens
 * naming the same code differently is exactly the bug this avoids. Wording unchanged, order unchanged (the
 * records page builds its flag filter dropdown from `Object.entries`, so the order is part of the UI).
 */
export const FLAG_LABEL: Record<string, string> = {
  LATE: "สาย",
  OUT_OF_WINDOW: "นอกช่วงเวลา",
  OUTSIDE_RADIUS: "นอกพื้นที่",
  NO_GPS: "ไม่มีตำแหน่ง",
  LOW_ACCURACY: "ตำแหน่งไม่แม่นยำ",
  PHOTO_MISSING: "ไม่มีรูป",
  NO_LOCATION_ASSIGNED: "ไม่ได้กำหนดสถานที่",
}

/** Thai label for a flag code; an unknown code is shown as-is rather than hidden. */
export function flagLabel(code: string): string {
  return FLAG_LABEL[code] ?? code
}
