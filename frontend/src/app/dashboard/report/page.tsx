"use client"

import React, { useCallback, useEffect, useState } from "react"
import { AlertCircle, BarChart2, Loader2, RefreshCw } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { isPermissionDenied } from "@/lib/errors"
import { flagLabel } from "@/lib/attendance-labels"
import { bangkokDay } from "@/lib/datetime"
import AccessDenied from "@/components/AccessDenied"

/**
 * HR report — flag × review outcome (task 061, round 1 item (c)).
 *
 * Answers "how many check-ins carried each flag, and what did HR decide about them": one row per flag code
 * present in the period, split over the four review statuses. The counting happens in the backend
 * (`GET /attendance/checkins/flag-outcomes`) inside PostgreSQL — no check-in row ever reaches the browser
 * or the Python process just to be counted.
 *
 * Conventions follow the other attendance pages: Bangkok days for the range (`bangkokDay`), the shared flag
 * labels (`flagLabel`, which prints an unknown code as itself), every call through `apiFetch` so a 401/403
 * behaves like everywhere else, and the dashboard's own Thai notice when the account lacks
 * `attendance-records`.
 */

const NO_PERMISSION_TH = "คุณไม่มีสิทธิ์ดูข้อมูลการลงเวลา กรุณาติดต่อผู้ดูแลระบบ"
const LOAD_ERROR_TH = "โหลดรายงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"
const NETWORK_ERROR_TH = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง"
const EMPTY_TH = "ไม่พบข้อมูลลงเวลาในช่วงที่เลือก"
const NO_FLAGS_TH = "ในช่วงนี้ไม่มีรายการที่มีแฟลก"
const LOCATION_LOAD_ERROR_TH = "โหลดรายชื่อสถานที่ไม่สำเร็จ"
/** The one thing about this table that is easy to misread, so the page says it out loud. */
const MULTI_FLAG_TH =
  "รายการเดียวที่มีหลายแฟลกจะถูกนับในแต่ละประเภทที่พบ จึงรวมกันได้มากกว่าจำนวนรายการที่มีแฟลก"

type ReviewStatus = "CLEAN" | "PENDING_REVIEW" | "ACCEPTED" | "REJECTED"

/** Column order the report agreed on: the review outcomes first, then `ปกติ` (rendered only when it is not
 *  zero anywhere in the answer), then the total. */
const REVIEW_COLUMNS: { key: ReviewStatus; label: string }[] = [
  { key: "PENDING_REVIEW", label: "รอตรวจ" },
  { key: "ACCEPTED", label: "ยอมรับ" },
  { key: "REJECTED", label: "ปฏิเสธ" },
  { key: "CLEAN", label: "ปกติ" },
]

interface FlagOutcome {
  flag: string
  total: number
  by_review_status: Record<ReviewStatus, number>
}

interface FlagOutcomes {
  date_from: string | null
  date_to: string | null
  total_checkins: number
  flagged_checkins: number
  by_flag: FlagOutcome[]
}

interface LocationOption {
  location_id: string | null
  location_name: string
}

/**
 * The first day of the current Bangkok month, as `YYYY-MM-DD`. Built from today's Bangkok day rather than
 * from date arithmetic, so month lengths and time zones cannot shift it: `2026-10-01`.
 */
function bangkokMonthStart(): string {
  return `${bangkokDay().slice(0, 8)}01`
}

export default function ReportPage() {
  const [dateFrom, setDateFrom] = useState(() => bangkokMonthStart())
  const [dateTo, setDateTo] = useState(() => bangkokDay())
  const [locationId, setLocationId] = useState("")
  const [locationOptions, setLocationOptions] = useState<LocationOption[]>([])
  const [locationOptionsFailed, setLocationOptionsFailed] = useState(false)

  const [data, setData] = useState<FlagOutcomes | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [accessDenied, setAccessDenied] = useState(false)

  // The location choices, fetched once (no date range on purpose — the filter must offer every location the
  // records mention). A failure leaves the dropdown at "ทุกสถานที่" and shows a small note; the report itself
  // keeps working.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/v1/attendance/checkins/locations")
        if (!res.ok) {
          if (!cancelled) setLocationOptionsFailed(true)
          return
        }
        const body = await res.json()
        if (!cancelled) {
          setLocationOptions(Array.isArray(body.items) ? body.items : [])
          setLocationOptionsFailed(false)
        }
      } catch (err) {
        if (isPermissionDenied(err as Error)) {
          setAccessDenied(true)
          return
        }
        if (!cancelled) setLocationOptionsFailed(true)
      }
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
      if (locationId) params.set("location_id", locationId)
      const res = await apiFetch(`/api/v1/attendance/checkins/flag-outcomes?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        // The backend's own Thai sentence (a range longer than 92 days, an inverted range) is more useful
        // than a generic one, so it wins when it is a string.
        setError(typeof body?.detail === "string" ? body.detail : LOAD_ERROR_TH)
        setData(null)
        return
      }
      setData(await res.json())
      setError("")
    } catch (err) {
      // `apiFetch` throws on 403 (it never returns that response) and redirects on 401.
      if (isPermissionDenied(err as Error)) {
        setAccessDenied(true)
        return
      }
      setError(NETWORK_ERROR_TH)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, locationId])

  // Debounced like the other attendance pages, and the first request starts in a timer callback rather than
  // synchronously inside the effect (the shape the hooks lint rule asks for here).
  useEffect(() => {
    const handle = setTimeout(() => {
      void load()
    }, 0)
    return () => clearTimeout(handle)
  }, [load])

  if (accessDenied) return <AccessDenied message={NO_PERMISSION_TH} />

  const rows = data?.by_flag ?? []
  const showClean = rows.some((row) => (row.by_review_status?.CLEAN ?? 0) > 0)
  const columns = REVIEW_COLUMNS.filter((column) => column.key !== "CLEAN" || showClean)
  const rangeText = data?.date_from && data?.date_to ? `${data.date_from} - ${data.date_to}` : ""

  const statClass = "bg-base-100 rounded-2xl border border-base-300 p-5 flex flex-col gap-1"
  const headClass = "px-4 py-3 text-[11px] font-black text-base-content/50 whitespace-nowrap"
  const cellClass = "px-4 py-3 text-sm font-bold tabular-nums whitespace-nowrap"

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-base-content flex items-center gap-2">
            <BarChart2 className="text-primary" /> รายงานการลงเวลา
          </h1>
          <p className="text-base-content/50 text-sm font-bold">ประเภทแฟลก × ผลการตรวจสอบ (ตามวันทำงานเวลาไทย)</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-base-100 border border-base-300 rounded-xl font-black text-xs text-base-content/60 hover:text-primary transition-all active:scale-95 cursor-pointer"
        >
          <RefreshCw size={14} /> รีเฟรช
        </button>
      </div>

      <div className="bg-base-100 rounded-2xl border border-base-300 shadow-sm p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block">
            <span className="text-[10px] font-black text-base-content/40 block mb-1.5">วันที่เริ่มต้น</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="input input-bordered input-sm w-full text-xs"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-black text-base-content/40 block mb-1.5">วันที่สิ้นสุด</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="input input-bordered input-sm w-full text-xs"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-black text-base-content/40 block mb-1.5">สถานที่</span>
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="select select-bordered select-sm w-full text-xs"
            >
              <option value="">ทุกสถานที่</option>
              {locationOptions.map((option) => (
                <option key={option.location_id ?? "none"} value={option.location_id ?? "none"}>
                  {option.location_name}
                </option>
              ))}
            </select>
            {locationOptionsFailed && (
              <span className="text-[10px] font-bold text-warning block mt-1">{LOCATION_LOAD_ERROR_TH}</span>
            )}
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-error/5 border border-error/20 rounded-2xl p-4 flex items-start gap-2">
          <AlertCircle size={16} className="text-error mt-0.5 shrink-0" />
          <p className="text-sm font-bold text-error">{error}</p>
        </div>
      )}

      {loading && !data && (
        <div className={statClass}>
          <p className="text-xs font-bold text-base-content/40 flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" /> กำลังโหลด...
          </p>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className={statClass}>
              <span className="text-[10px] font-black text-base-content/40">รายการที่มีแฟลก</span>
              <span className="text-2xl font-black tabular-nums text-base-content">{data.flagged_checkins}</span>
              <span className="text-[11px] font-bold text-base-content/50">
                จากทั้งหมด {data.total_checkins} รายการในช่วงนี้
              </span>
            </div>
            <div className={statClass}>
              <span className="text-[10px] font-black text-base-content/40">ช่วงข้อมูล</span>
              <span className="text-sm font-black text-base-content">{rangeText}</span>
              <span className="text-[11px] font-bold text-base-content/50">
                {locationId === "" ? "ทุกสถานที่" : "กรองตามสถานที่ที่เลือก"}
              </span>
            </div>
          </div>

          <div className="bg-base-100 rounded-2xl border border-base-300 overflow-x-auto shadow-sm">
            <table className="w-full text-left min-w-[560px]">
              <thead className="bg-base-200/60 border-b border-base-300">
                <tr>
                  <th className={headClass}>ประเภทแฟลก</th>
                  {columns.map((column) => (
                    <th key={column.key} className={`${headClass} text-right`}>
                      {column.label}
                    </th>
                  ))}
                  <th className={`${headClass} text-right`}>รวม</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 2} className="px-4 py-12 text-center text-sm font-bold text-base-content/50">
                      {data.total_checkins === 0 ? EMPTY_TH : NO_FLAGS_TH}
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr key={row.flag} className="hover:bg-base-200/40 transition-colors">
                    <td className={cellClass}>
                      <span className="text-base-content">{flagLabel(row.flag)}</span>
                      <span className="block text-[10px] font-bold text-base-content/40">{row.flag}</span>
                    </td>
                    {columns.map((column) => (
                      <td key={column.key} className={`${cellClass} text-right text-base-content/80`}>
                        {row.by_review_status?.[column.key] ?? 0}
                      </td>
                    ))}
                    <td className={`${cellClass} text-right text-base-content`}>{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] font-bold text-base-content/50">{MULTI_FLAG_TH}</p>
        </>
      )}
    </div>
  )
}
