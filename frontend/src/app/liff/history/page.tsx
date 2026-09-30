"use client"

import { useCallback, useEffect, useState } from "react"
import Script from "next/script"
import { formatThaiDayWithWeekday, formatThaiMonth } from "@/lib/datetime"

/**
 * "ประวัติการลงเวลา" — the employee's own check-in history (task 029).
 *
 * Reached from the second live rich-menu button (`https://liff.line.me/<LIFF_ID>/history`), which lands
 * on the `/liff` entry page and is forwarded here exactly like `/liff/checkin`.
 *
 * Three rules shaped this page:
 *
 * * **The employee's own data only.** The API takes no employee id — the identity is the verified LINE
 *   ID token — so there is nothing on this page that could ask for somebody else's records.
 * * **Gentle wording.** This is what a person reads about themselves: no blame, no red alarms, and the
 *   review states are sentences ("รอฝ่ายบุคคลตรวจสอบ"), never codes.
 * * **Nothing private leaves the API**, so there is nothing here to hide: no photo, no map, no HR note.
 */

type LiffSdk = {
  init: (config: { liffId: string }) => Promise<void>
  isLoggedIn: () => boolean
  login: () => void
  getIDToken: () => string | null
}

const readLiff = (): LiffSdk | undefined => (window as unknown as { liff?: LiffSdk }).liff

type HistoryItem = {
  id: string
  round_name: string | null
  checkin_time: string | null
  time_display: string | null
  time_status: string
  location_status: string
  review_status: string
  flags: string[]
}

type HistoryDay = { work_date: string; items: HistoryItem[] }

type HistorySummary = {
  days_with_checkins: number
  on_time: number
  late: number
  out_of_window: number
  pending_review: number
}

type HistoryPayload = { month: string; days: HistoryDay[]; summary: HistorySummary }

type Stage = "loading" | "ready" | "error"

const MONTHS_BACK = 12  // must match HISTORY_MONTHS_BACK in backend/app/attendance_router.py
const UNKNOWN_ROUND_NAME_TH = "รอบที่ไม่ระบุ"

// The same Thai wording as the check-in page for the identity failures (task 018/021).
const MSG_SESSION_EXPIRED = "เซสชัน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE"
const MSG_CANNOT_VERIFY = "ตรวจสอบตัวตนไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"
const MSG_NO_ID_TOKEN =
  "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดหน้านี้จากแอป LINE อีกครั้ง หากยังพบปัญหา กรุณาติดต่อผู้ดูแลระบบ"
const MSG_GENERIC_ERROR = "เกิดข้อผิดพลาด กรุณาติดต่อผู้ดูแลระบบ"
const MSG_CANNOT_CONNECT = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง"
const MSG_NO_LIFF = "ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาเปิดหน้านี้ในแอป LINE อีกครั้ง"
const MSG_NO_LIFF_ID = "LIFF ID ยังไม่ได้ตั้งค่าในระบบ กรุณาติดต่อผู้ดูแลระบบ"
const MSG_EMPTY_MONTH = "เดือนนี้ยังไม่มีข้อมูลการลงเวลา"
const MSG_FOOTER = "ข้อมูลนี้ใช้อ้างอิงเท่านั้น ไม่ใช่ผลสรุปเวลาทำงานสำหรับเงินเดือน"

/** Gentle wording + a calm colour per status. A status we do not know shows nothing (never a code). */
const TIME_STATUS_TH: Record<string, string> = {
  ON_TIME: "ตรงเวลา",
  LATE: "สาย",
  EARLY_OUT_OF_WINDOW: "นอกช่วงเวลาลงเวลา",
  LATE_OUT_OF_WINDOW: "นอกช่วงเวลาลงเวลา",
}

const TIME_STATUS_CLASS: Record<string, string> = {
  ON_TIME: "bg-emerald-500/10 text-emerald-700",
  LATE: "bg-amber-500/10 text-amber-700",
  EARLY_OUT_OF_WINDOW: "bg-amber-500/10 text-amber-700",
  LATE_OUT_OF_WINDOW: "bg-amber-500/10 text-amber-700",
}

const LOCATION_TH: Record<string, string> = {
  INSIDE: "ในพื้นที่",
  OUTSIDE: "นอกพื้นที่",
  UNKNOWN: "ไม่มีข้อมูลตำแหน่ง",
  NO_LOCATION_ASSIGNED: "ไม่มีข้อมูลตำแหน่ง",
}

const REVIEW_TH: Record<string, string> = {
  PENDING_REVIEW: "รอฝ่ายบุคคลตรวจสอบ",
  ACCEPTED: "ฝ่ายบุคคลรับทราบแล้ว",
  REJECTED: "ฝ่ายบุคคลไม่รับรายการนี้ — ติดต่อฝ่ายบุคคลหากมีข้อสงสัย",
  // CLEAN deliberately has no sentence: nothing to say when everything is in order.
}

/**
 * Only the flags that add something the chips do not already say. Every other code is ignored in
 * silence — a raw code must never reach the screen.
 */
const EXTRA_FLAG_TH: Record<string, string> = {
  NO_GPS: "ไม่ได้รับตำแหน่งจากเครื่อง",
  LOW_ACCURACY: "ตำแหน่งคลาดเคลื่อนค่อนข้างมาก",
  PHOTO_MISSING: "รูปยังไม่ถูกบันทึก",
}

/** `YYYY-MM` shifted by whole months (negative = back). Pure string maths, no timezone involved. */
function shiftMonth(month: string, months: number): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1
  const total = year * 12 + index + months
  const nextYear = Math.floor(total / 12)
  const nextMonth = total % 12 + 1
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`
}

export default function LiffHistoryPage() {
  const [stage, setStage] = useState<Stage>("loading")
  const [errorMsg, setErrorMsg] = useState("")
  const [idToken, setIdToken] = useState<string | null>(null)
  const [liffReady, setLiffReady] = useState(false)
  const [month, setMonth] = useState<string | null>(null)
  const [newestMonth, setNewestMonth] = useState<string | null>(null)
  const [data, setData] = useState<HistoryPayload | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Load one month. Without `wanted` the server decides the month — and, because it answered with the
   * month it used, the page also learns where "this month" is on the server's Bangkok clock. That
   * anchor is what bounds the two arrows, so a phone with a wrong clock cannot open a future month.
   */
  const loadMonth = useCallback(async (token: string, wanted: string | null) => {
    setBusy(true)
    try {
      const suffix = wanted ? `?month=${wanted}` : ""
      const res = await fetch(`/api/v1/attendance/me/history${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        setErrorMsg(MSG_SESSION_EXPIRED)
        setStage("error")
        return
      }
      if (res.status === 503) {
        setErrorMsg(MSG_CANNOT_VERIFY)
        setStage("error")
        return
      }
      if (!res.ok) {
        // 403/404 (not bound, pending, revoked) and 422 (a month outside the window) carry a Thai
        // sentence from the server — show it as it is.
        const body = await res.json().catch(() => null)
        setErrorMsg(body?.detail || MSG_GENERIC_ERROR)
        setStage("error")
        return
      }
      const body = (await res.json()) as HistoryPayload
      setData(body)
      setMonth(body.month)
      setNewestMonth((current) => current ?? body.month)
      setStage("ready")
    } catch {
      setErrorMsg(MSG_CANNOT_CONNECT)
      setStage("error")
    } finally {
      setBusy(false)
    }
  }, [])

  const initLiff = useCallback(
    async (liffId: string) => {
      const sdk = readLiff()
      if (!sdk) {
        setErrorMsg(MSG_NO_LIFF)
        setStage("error")
        return
      }
      try {
        await sdk.init({ liffId })
        if (!sdk.isLoggedIn()) {
          sdk.login()
          return
        }
        let token: string | null = null
        try {
          token = sdk.getIDToken()
        } catch {
          token = null
        }
        if (typeof token !== "string" || !token) {
          setErrorMsg(MSG_NO_ID_TOKEN)
          setStage("error")
          return
        }
        setIdToken(token)
        await loadMonth(token, null)
      } catch {
        setErrorMsg(MSG_NO_LIFF)
        setStage("error")
      }
    },
    [loadMonth],
  )

  useEffect(() => {
    if (!liffReady) return
    const boot = async () => {
      try {
        const res = await fetch("/api/v1/settings")
        if (!res.ok) throw new Error("settings")
        const settings = await res.json()
        const liffId: string | undefined = settings.line_liff_id
        if (liffId && liffId !== "YOUR_LIFF_ID") await initLiff(liffId)
        else {
          setErrorMsg(MSG_NO_LIFF_ID)
          setStage("error")
        }
      } catch {
        setErrorMsg("ไม่สามารถดึงข้อมูลการตั้งค่าเริ่มต้นได้ กรุณาติดต่อผู้ดูแลระบบ")
        setStage("error")
      }
    }
    boot()
  }, [liffReady, initLiff])

  const oldestMonth = newestMonth ? shiftMonth(newestMonth, -MONTHS_BACK) : null
  const canGoBack = Boolean(month && oldestMonth && month > oldestMonth)
  const canGoForward = Boolean(month && newestMonth && month < newestMonth)

  const go = (delta: number) => {
    if (!idToken || !month) return
    const target = shiftMonth(month, delta)
    if (oldestMonth && target < oldestMonth) return
    if (newestMonth && target > newestMonth) return
    setStage("loading")
    loadMonth(idToken, target)
  }

  const summary = data?.summary
  const summaryText = summary
    ? [
        `ลงเวลา ${summary.days_with_checkins} วัน`,
        `ตรงเวลา ${summary.on_time} ครั้ง`,
        `สาย ${summary.late} ครั้ง`,
        ...(summary.out_of_window > 0 ? [`นอกช่วงเวลา ${summary.out_of_window} ครั้ง`] : []),
        ...(summary.pending_review > 0 ? [`รอตรวจ ${summary.pending_review} รายการ`] : []),
      ].join(" · ")
    : ""

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setLiffReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
        <div className="w-full max-w-sm space-y-4 py-4">
          <div className="bg-[#06C755] rounded-3xl px-6 py-6 text-white shadow-xl">
            <p className="text-xs text-white/80">บันทึกของฉัน</p>
            <p className="font-black text-lg mt-0.5">ประวัติการลงเวลา</p>
            <p className="text-white/80 text-xs mt-1">ย้อนหลังได้ {MONTHS_BACK} เดือน</p>
          </div>

          {/* === LOADING === */}
          {stage === "loading" && (
            <div className="bg-base-100 rounded-3xl shadow-xl p-10 text-center border border-base-300">
              <div className="w-12 h-12 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-6 h-6 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">กำลังโหลด...</p>
            </div>
          )}

          {/* === READY === */}
          {stage === "ready" && data && month && (
            <>
              <div className="bg-base-100 rounded-3xl border border-base-300 shadow-lg p-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={!canGoBack || busy}
                  aria-label="เดือนก่อนหน้า"
                  className="w-11 h-11 shrink-0 rounded-2xl bg-base-200 hover:bg-base-300 disabled:opacity-40 font-black text-lg transition-all"
                >
                  ‹
                </button>
                <p className="font-black text-sm text-base-content text-center">{formatThaiMonth(month)}</p>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={!canGoForward || busy}
                  aria-label="เดือนถัดไป"
                  className="w-11 h-11 shrink-0 rounded-2xl bg-base-200 hover:bg-base-300 disabled:opacity-40 font-black text-lg transition-all"
                >
                  ›
                </button>
              </div>

              {summaryText && (
                <p className="text-xs text-base-content/60 text-center" data-summary="true">
                  {summaryText}
                </p>
              )}

              {data.days.length === 0 && (
                <div className="bg-base-100 rounded-3xl border border-base-300 p-6 text-center">
                  <p className="text-sm text-base-content/70">{MSG_EMPTY_MONTH}</p>
                </div>
              )}

              {data.days.map((day) => (
                <div key={day.work_date} className="bg-base-100 rounded-3xl border border-base-300 shadow-lg overflow-hidden">
                  <div className="px-4 py-3 bg-base-200/60 border-b border-base-300">
                    <p className="font-bold text-xs text-base-content/80">
                      {formatThaiDayWithWeekday(day.work_date)}
                    </p>
                  </div>
                  <div className="divide-y divide-base-300">
                    {day.items.map((item) => (
                      <div key={item.id} className="px-4 py-3 space-y-1.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-bold text-sm text-base-content truncate">
                              {item.round_name || UNKNOWN_ROUND_NAME_TH}
                            </p>
                            <p className="text-xs text-base-content/50 mt-0.5">
                              {item.time_display ? `เวลา ${item.time_display} น.` : ""}
                            </p>
                          </div>
                          {TIME_STATUS_TH[item.time_status] && (
                            <span
                              className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold ${
                                TIME_STATUS_CLASS[item.time_status] || "bg-base-200 text-base-content/60"
                              }`}
                            >
                              {TIME_STATUS_TH[item.time_status]}
                            </span>
                          )}
                        </div>
                        {LOCATION_TH[item.location_status] && (
                          <p className="text-xs text-base-content/60">📍 {LOCATION_TH[item.location_status]}</p>
                        )}
                        {item.flags
                          .filter((flag) => EXTRA_FLAG_TH[flag])
                          .map((flag) => (
                            <p key={flag} className="text-xs text-base-content/60">
                              • {EXTRA_FLAG_TH[flag]}
                            </p>
                          ))}
                        {REVIEW_TH[item.review_status] && (
                          <p className="text-xs text-base-content/60 bg-base-200/60 rounded-xl px-3 py-2">
                            {REVIEW_TH[item.review_status]}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <p className="text-center text-[11px] text-base-content/40 px-2">{MSG_FOOTER}</p>
            </>
          )}

          {/* === ERROR === */}
          {stage === "error" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-amber-500 px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">⚠️</p>
                <p className="font-black text-base">ยังดูประวัติไม่ได้</p>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-base-content/70 text-center">{errorMsg}</p>
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg("")
                    if (idToken && month) {
                      // A month failed to load: the session is still good, so just ask again.
                      loadMonth(idToken, month)
                      return
                    }
                    // Nothing loaded yet: run the whole boot again. `<Script onReady>` fires only once,
                    // so `liffReady` is cycled false → true to re-run the effect (the check-in page's
                    // trick) — without the second half the page would sit on the loading card for ever.
                    setStage("loading")
                    setLiffReady(false)
                    setTimeout(() => setLiffReady(true), 0)
                  }}
                  className="w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  ลองใหม่อีกครั้ง
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
