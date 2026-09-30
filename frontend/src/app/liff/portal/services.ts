/**
 * The service hub's registry (task 031).
 *
 * The Rich Menu is only the **fast lane** for the jobs people do every day; "ศูนย์รวมบริการ" opens this
 * hub, which lists *every* service and can grow without cluttering the menu. That is the master spec's
 * "Dock & Portal" idea — and this one file is where the hub's content lives.
 *
 * **Adding or switching on a service = editing one entry here** (and creating its page):
 *
 *   * `status: "live"` + `href: "/liff/<page>"` → it appears under "ใช้งานได้ตอนนี้" as a tappable card;
 *   * `status: "soon"` (no `href`)            → it appears under "เร็วๆ นี้" as a dimmed, non-tappable card.
 *
 * Rules the page and the suite rely on (see `portalServiceProblems`):
 *   * `key` is unique (React's key and the browser check's handle);
 *   * a `live` entry always carries an `href` that starts with `/liff/` — the ONLY links the hub may open,
 *     because they are the pages behind the same LIFF app (Endpoint URL `…/liff`);
 *   * a `soon` entry carries no `href` at all, so it cannot become a dead link by accident.
 *
 * Everything here is Thai, plain and one line long: this is a page every employee sees, and the "soon"
 * descriptions are also the answer to "what else will this app do?" — so they name the future service
 * without promising a date.
 */

export type PortalStatus = "live" | "soon"

export type PortalService = {
  key: string
  title: string
  description: string
  href?: string
  status: PortalStatus
}

export const PORTAL_SERVICES: PortalService[] = [
  // ── usable today (a LIFF page exists) ──────────────────────────────────────────────────────────────
  { key: "checkin", title: "ลงเวลา", description: "บันทึกเวลาเข้า–ออกงานพร้อมรูปถ่ายและตำแหน่ง", href: "/liff/checkin", status: "live" },
  { key: "rounds", title: "รอบลงเวลาของฉัน", description: "ดูรอบ เวลา และสถานที่ลงเวลาของคุณ", href: "/liff/rounds", status: "live" },
  { key: "history", title: "ประวัติการลงเวลา", description: "ดูสิ่งที่ระบบบันทึกไว้ให้คุณย้อนหลัง 12 เดือน", href: "/liff/history", status: "live" },
  // ── coming (visible on purpose: staff see what is next, the User switches each one on later) ──────
  { key: "news", title: "ข่าวสารองค์กร", description: "ประกาศและข่าวของบริษัทที่ฝ่ายบุคคลส่งถึงพนักงาน", status: "soon" },
  { key: "faq", title: "ถามตอบ HR", description: "คำถามที่พนักงานถามบ่อย พร้อมคำตอบจากฝ่ายบุคคล", status: "soon" },
  { key: "feedback", title: "ส่งข้อเสนอแนะ (ไม่ระบุตัวตน)", description: "ส่งความคิดเห็นถึงบริษัทโดยไม่ต้องแจ้งชื่อ", status: "soon" },
  { key: "payslip", title: "สลิปเงินเดือน", description: "ดูสลิปเงินเดือนของตัวเองย้อนหลัง", status: "soon" },
  { key: "certificate", title: "ขอหนังสือรับรอง", description: "ขอหนังสือรับรองการทำงานและติดตามสถานะคำขอ", status: "soon" },
  { key: "leave", title: "ลางาน", description: "ยื่นคำขอลาและดูวันลาคงเหลือของตัวเอง", status: "soon" },
]

/**
 * The link a card may open, or `null` when it must not be a link at all.
 *
 * A `soon` entry never has one, and a `live` entry without a `href` (or with an `href` that would leave
 * the LIFF app) is treated the same way: the page then renders it in **neither** section rather than as a
 * dead link — `portalServiceProblems()` reports such an entry so the mistake is loud in the suite.
 */
export function serviceHref(service: PortalService): string | null {
  if (service.status !== "live") return null
  const href = service.href
  return typeof href === "string" && href.startsWith("/liff/") ? href : null
}

/** Everything a card needs, or `null` when the entry is not usable and must be skipped. */
export function liveServiceHref(service: PortalService): string | null {
  return serviceHref(service)
}

/**
 * The registry's own rules, as a list of problems (empty = fine).
 *
 * Exported so the rules are checkable code instead of a comment: the 031 suite parses this file and
 * re-states the same rules, and any future page or script can call this directly.
 */
export function portalServiceProblems(list: PortalService[] = PORTAL_SERVICES): string[] {
  const problems: string[] = []
  const keys = list.map((service) => service.key)
  if (new Set(keys).size !== keys.length) problems.push("key ซ้ำกันในทะเบียนบริการ")
  for (const service of list) {
    if (!service.key || !service.title || !service.description) {
      problems.push(`บริการ ${service.key || "(ไม่มี key)"} ต้องมี key, title และ description`)
    }
    if (!service.title.trim() || !service.description.trim()) {
      problems.push(`บริการ ${service.key} มีข้อความว่าง`)
    }
    if (service.status !== "live" && service.status !== "soon") {
      problems.push(`บริการ ${service.key} มีสถานะที่ไม่รู้จัก`)
    }
    if (service.status === "live" && !serviceHref(service)) {
      problems.push(`บริการ ${service.key} เปิดใช้แล้วแต่ไม่มีลิงก์ /liff/...`)
    }
    if (service.status === "soon" && service.href) {
      problems.push(`บริการ ${service.key} ยังไม่เปิดใช้แต่มีลิงก์`)
    }
  }
  return problems
}
