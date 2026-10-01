"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Download,
  Filter,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { apiFetch } from "@/lib/api"
import { isPermissionDenied } from "@/lib/errors"
import { FLAG_LABEL } from "@/lib/attendance-labels"
import AccessDenied from "@/components/AccessDenied"

/**
 * HR attendance records (task 022).
 *
 * One screen for "what happened today, and which records need a decision": filter, read the evidence
 * (time, place, distance, photo), then accept or reject the flagged ones. The check-in itself is never
 * blocked — that decision is made here, after the fact, with a trail.
 *
 * Reads and reviews both use the session cookie through `apiFetch`, so the backend is the only thing
 * that decides who may see a record or a photo. The photo is fetched as bytes and shown through an
 * object URL: that way "the file is gone" can be told apart from "the image is broken" and the URL
 * never exists outside this tab.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type ReviewStatus = "CLEAN" | "PENDING_REVIEW" | "ACCEPTED" | "REJECTED"

interface Checkin {
  id: string
  employee_id: string
  full_name: string | null
  department: string | null
  work_date: string
  checked_at: string
  round_label: string | null
  round_seq: number | null
  template_name: string | null
  expected_time: string | null
  window_start: string | null
  window_end: string | null
  grace_minutes: number | null
  photo_required: boolean
  time_status: string
  lat: number | null
  lng: number | null
  accuracy_m: number | null
  gps_status: string
  matched_location_name: string | null
  distance_m: number | null
  location_status: string
  photo_key: string | null
  photo_status: string
  flags: string[]
  review_status: ReviewStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  photo_url: string | null
}

interface Summary {
  date_from: string | null
  date_to: string | null
  total: number
  by_review_status: Record<ReviewStatus, number>
  by_flag: Record<string, number>
}

interface Filters {
  dateFrom: string
  dateTo: string
  q: string
  flag: string
  timeStatus: string
  locationStatus: string
  reviewStatus: string
  /** Task 061: "" = every location, "none" = records that matched no location, otherwise a location id. */
  locationId: string
}

/** One choice of the location filter. `location_id: null` is the API's "ไม่ระบุสถานที่" group. */
interface LocationOption {
  location_id: string | null
  location_name: string
}

// ─── Thai wording (codes come from the API and never change; only these labels do) ─────────────

const REVIEW_LABEL: Record<ReviewStatus, string> = {
  CLEAN: "ปกติ",
  PENDING_REVIEW: "รอตรวจ",
  ACCEPTED: "ยอมรับแล้ว",
  REJECTED: "ไม่ยอมรับ",
}

const REVIEW_CLASS: Record<ReviewStatus, string> = {
  CLEAN: "bg-success/10 text-success",
  PENDING_REVIEW: "bg-amber-500/10 text-amber-600",
  ACCEPTED: "bg-primary/10 text-primary",
  REJECTED: "bg-error/10 text-error",
}

const TIME_LABEL: Record<string, string> = {
  ON_TIME: "ตรงเวลา",
  LATE: "สาย",
  EARLY_OUT_OF_WINDOW: "ก่อนช่วงเวลา",
  LATE_OUT_OF_WINDOW: "หลังช่วงเวลา",
}

const LOCATION_LABEL: Record<string, string> = {
  INSIDE: "ในพื้นที่",
  OUTSIDE: "นอกพื้นที่",
  UNKNOWN: "ไม่มีตำแหน่ง",
  NO_LOCATION_ASSIGNED: "ไม่ได้กำหนดสถานที่",
}

/** Every flag code `checkin_logic.py` can produce (verified against that file, not guessed). */

const PHOTO_STATUS_LABEL: Record<string, string> = {
  OK: "มีรูป",
  NOT_REQUIRED_NOT_SENT: "ไม่ต้องใช้รูป",
  MISSING_NOT_SENT: "ไม่ได้แนบรูป",
  MISSING_REJECTED: "รูปถูกปฏิเสธ",
  MISSING_STORAGE: "บันทึกรูปไม่สำเร็จ",
}

const PAGE_SIZES = [10, 20, 50, 100]

function todayBangkok(): string {
  // en-CA gives YYYY-MM-DD; the timezone is the one the backend uses for work_date.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" })
}

function hhmm(iso: string | null): string {
  if (!iso) return "-"
  return new Date(iso).toLocaleTimeString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function stamp(iso: string | null): string {
  if (!iso) return "-"
  return new Date(iso).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * `YYYY-MM-DD` (CE) -> `DD/MM/YYYY` in the Buddhist Era, the way dates read everywhere else on this
 * page. Used by the two date filters: a native `<input type="date">` box can only ever display the
 * *browser's* locale (e.g. `09/29/2026` on an en-US machine) no matter what `lang` says.
 */
function isoToThaiDate(iso: string): string {
  const [year, month, day] = iso.split("-")
  if (!year || !month || !day) return ""
  return `${day}/${month}/${Number(year) + 543}`
}

/**
 * `DD/MM/YYYY` back to `YYYY-MM-DD`. A year above 2400 is read as Buddhist Era and converted, and a
 * real calendar date is required, so `31/02/2569` is rejected instead of silently rolling over.
 */
function thaiDateToIso(text: string): string | null {
  const parts = text.trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/)
  if (!parts) return null
  const day = Number(parts[1])
  const month = Number(parts[2])
  const rawYear = Number(parts[3])
  const year = rawYear > 2400 ? rawYear - 543 : rawYear
  if (month < 1 || month > 12 || day < 1) return null
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day) return null
  return iso
}

/**
 * `work_date` arrives as a plain `YYYY-MM-DD` string, so it is pinned to UTC midnight and read in
 * Asia/Bangkok: the calendar day never shifts, and `th-TH` prints the Buddhist Era an HR reader
 * expects (the same convention as `stamp`).
 */
function workDateText(value: string | null): string {
  if (!value) return "-"
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

function distanceText(value: number | null): string {
  if (value === null) return ""
  return value >= 1000 ? ` (${(value / 1000).toFixed(1)} กม.)` : ` (${Math.round(value)} ม.)`
}

function apiErrorMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail
  return fallback
}

export default function AttendanceRecordsPage() {
  const today = todayBangkok()
  const [accessDenied, setAccessDenied] = useState(false)
  const [filters, setFilters] = useState<Filters>({
    dateFrom: today,
    dateTo: today,
    q: "",
    flag: "",
    timeStatus: "",
    locationStatus: "",
    reviewStatus: "",
    locationId: "",
  })
  const [searchInput, setSearchInput] = useState("")
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  // Location filter (task 061). The choices come from the check-ins themselves
  // (`GET /attendance/checkins/locations`), not from `attendance_locations`, because a record may name a
  // location that has since been deleted — and it is `attendance-records`, not `locations`, that guards it,
  // so a records reader can fill the dropdown without being given the settings menu.
  const [locationOptions, setLocationOptions] = useState<LocationOption[]>([])
  const [locationOptionsFailed, setLocationOptionsFailed] = useState(false)
  // The two date boxes are plain text so they can show Thai Buddhist-Era dates; these hold what the
  // user is typing and only ever move the query when the text parses (see thaiDateToIso).
  const [fromText, setFromText] = useState(() => isoToThaiDate(today))
  const [toText, setToText] = useState(() => isoToThaiDate(today))

  // CSV export dialog (task 024). Its date boxes are separate from the table's filters on purpose:
  // HR often exports a different range than the one on screen, without disturbing the table.
  const [exportOpen, setExportOpen] = useState(false)
  const [exportKind, setExportKind] = useState<"detail" | "daily">("detail")
  const [exportFrom, setExportFrom] = useState(() => isoToThaiDate(today))
  const [exportTo, setExportTo] = useState(() => isoToThaiDate(today))
  const [exportPending, setExportPending] = useState(false)
  const [exportRejected, setExportRejected] = useState(false)
  const [exportRunning, setExportRunning] = useState(false)
  const [exportMessage, setExportMessage] = useState("")
  // Counters for the dialog's range, so HR is told what the file will (not) contain before downloading.
  const [rangeCounts, setRangeCounts] = useState<{ total: number; pending: number } | null>(null)
  const [rangeCountsFailed, setRangeCountsFailed] = useState(false)
  // The flag / time-status / location-status filters live behind "ตัวกรองเพิ่มเติม" so the toolbar
  // stays short on every screen size (Amendment 1).
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [rows, setRows] = useState<Checkin[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string }>({ type: "success", text: "" })

  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<Checkin | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState("")
  const [confirmBulk, setConfirmBulk] = useState(false)

  // The open record's photo bytes, plus the object URL that is revoked when it closes.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [photoState, setPhotoState] = useState<"none" | "loading" | "ready" | "missing">("none")
  const objectUrls = useRef<string[]>([])

  const queryString = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams()
      if (filters.dateFrom) params.set("date_from", filters.dateFrom)
      if (filters.dateTo) params.set("date_to", filters.dateTo)
      if (filters.q.trim()) params.set("q", filters.q.trim())
      if (filters.timeStatus) params.set("time_status", filters.timeStatus)
      if (filters.locationStatus) params.set("location_status", filters.locationStatus)
      if (filters.reviewStatus) params.set("review_status", filters.reviewStatus)
      if (filters.flag) params.set("flag", filters.flag)
      if (filters.locationId) params.set("location_id", filters.locationId)
      if (flaggedOnly) params.set("has_flags", "true")
      for (const [key, value] of Object.entries(extra)) params.set(key, value)
      return params.toString()
    },
    [filters, flaggedOnly],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = queryString({ page: String(page), page_size: String(pageSize) })
      const [listRes, summaryRes] = await Promise.all([
        apiFetch(`/api/v1/attendance/checkins?${query}`),
        apiFetch(`/api/v1/attendance/checkins/summary?${queryString()}`),
      ])
      if (!listRes.ok || !summaryRes.ok) {
        const body = await listRes.json().catch(() => null)
        setMessage({ type: "error", text: apiErrorMessage(body?.detail, "โหลดรายการลงเวลาไม่สำเร็จ") })
        return
      }
      const list = await listRes.json()
      setRows(list.items ?? [])
      setTotal(list.total ?? 0)
      setSummary(await summaryRes.json())
      setSelected([])
      // A load that worked clears a stale *error* banner (e.g. "range ends before it starts" after
      // the user fixes the range); a success banner from a review stays until it is dismissed.
      setMessage((current) => (current.type === "error" ? { type: "success", text: "" } : current))
    } catch (error) {
      // apiFetch throws PermissionDeniedError on 403 (it never returns that response) and
      // SessionExpiredError after it has already redirected to /login.
      if (isPermissionDenied(error as Error)) {
        setAccessDenied(true)
        return
      }
      setMessage({ type: "error", text: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง" })
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, queryString])

  // Debounced like the other attendance pages: the first state update happens in a timer callback
  // rather than synchronously inside the effect, and a burst of filter changes collapses into one
  // request (polling is not used here — nothing changes on its own).
  useEffect(() => {
    const handle = setTimeout(() => {
      void load()
    }, 0)
    return () => clearTimeout(handle)
  }, [load])

  // Revoke every object URL this page created when it goes away.
  useEffect(() => {
    return () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrls.current = []
    }
  }, [])

  // The location dropdown's choices (task 061), fetched once **without** a date range: the filter must
  // offer every location the records mention, not only the ones inside the range on screen — a choice that
  // disappears as HR narrows the range is a trap. A failure only leaves the dropdown at "ทุกสถานที่"
  // (`locationOptionsFailed` shows a small note): the table, the chips and the export keep working.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/v1/attendance/checkins/locations")
        if (!res.ok) {
          if (!cancelled) setLocationOptionsFailed(true)
          return
        }
        const data = await res.json()
        if (!cancelled) {
          setLocationOptions(Array.isArray(data.items) ? data.items : [])
          setLocationOptionsFailed(false)
        }
      } catch (error) {
        if (isPermissionDenied(error as Error)) {
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

  // The pending count for the export dialog's range. Debounced and cancelled like `load`, and every
  // state update happens inside a timer callback (never synchronously in the effect) — the same shape
  // the rest of this page uses.
  useEffect(() => {
    if (!exportOpen) return
    const from = thaiDateToIso(exportFrom)
    const to = thaiDateToIso(exportTo)
    let cancelled = false
    const handle = setTimeout(async () => {
      // Every state update lives in this callback (never synchronously in the effect body), which is
      // the shape the rest of this page uses and what the hooks lint rule asks for.
      if (!from || !to || from > to) {
        setRangeCounts(null)
        setRangeCountsFailed(false)
        return
      }
      // A new range must never show (or be judged by) the previous range's numbers: the count is a
      // helper, so while it is unknown the download stays available — the export validates its own
      // range and the server answers with a Thai message if it refuses.
      setRangeCounts(null)
      setRangeCountsFailed(false)
      // A refusal that belongs to the previous range ("a range longer than 92 days") must not sit next
      // to a range that is fine now — the same stale-message lesson as the table's banner.
      setExportMessage("")
      try {
        const locationQuery = filters.locationId
          ? `&location_id=${encodeURIComponent(filters.locationId)}`
          : ""
        const res = await apiFetch(
          `/api/v1/attendance/checkins/summary?date_from=${from}&date_to=${to}${locationQuery}`,
        )
        if (!res.ok) {
          if (!cancelled) setRangeCountsFailed(true)
          return
        }
        const data = await res.json()
        if (!cancelled) {
          setRangeCounts({
            total: data.total ?? 0,
            pending: data.by_review_status?.PENDING_REVIEW ?? 0,
          })
          setRangeCountsFailed(false)
        }
      } catch {
        if (!cancelled) setRangeCountsFailed(true)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [exportOpen, exportFrom, exportTo, filters.locationId])

  /** Fetch the open record's photo as bytes and hand the <img> an object URL.
   *
   *  The row thumbnails use a plain <img> (cheap, and the route takes the session cookie the same
   *  way), but the detail view goes through `apiFetch` so that "the file is gone" can be said out
   *  loud instead of showing a broken image — the difference matters when a NAS is down.
   */
  const loadPhoto = useCallback(async (record: Checkin) => {
    if (!record.photo_key) {
      setPhotoState("none")
      return
    }
    setPhotoState("loading")
    try {
      const response = await apiFetch(`/api/v1/attendance/photos/${record.photo_key}`)
      if (!response.ok) {
        setPhotoState("missing")
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      objectUrls.current.push(url)
      setPhotoUrl(url)
      setPhotoState("ready")
    } catch (error) {
      if (isPermissionDenied(error as Error)) {
        setAccessDenied(true)
        return
      }
      setPhotoState("missing")
    }
  }, [])

  const openDetail = async (record: Checkin) => {
    setDetail(record)
    setRejectOpen(false)
    setRejectNote("")
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl)
      setPhotoUrl(null)
    }
    setPhotoState(record.photo_key ? "loading" : "none")
    setDetailLoading(true)
    try {
      const response = await apiFetch(`/api/v1/attendance/checkins/${record.id}`)
      if (response.ok) {
        const fresh: Checkin = await response.json()
        setDetail(fresh)
        loadPhoto(fresh)
      } else if (response.status === 404) {
        setMessage({ type: "error", text: "ไม่พบรายการลงเวลานี้" })
      }
    } catch (error) {
      if (isPermissionDenied(error as Error)) {
        setAccessDenied(true)
        return
      }
      setMessage({ type: "error", text: "โหลดรายละเอียดไม่สำเร็จ" })
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl)
    setPhotoUrl(null)
    setDetail(null)
    setPhotoState("none")
  }

  const applyReview = async (status: "ACCEPTED" | "REJECTED", note?: string) => {
    if (!detail) return
    setSaving(true)
    try {
      const response = await apiFetch(`/api/v1/attendance/checkins/${detail.id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_status: status, note: note ?? null }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setMessage({ type: "error", text: apiErrorMessage(body?.detail, "บันทึกผลการตรวจสอบไม่สำเร็จ") })
        return
      }
      setDetail(body as Checkin)
      setRejectOpen(false)
      setRejectNote("")
      setMessage({
        type: "success",
        text: status === "ACCEPTED" ? "ยอมรับรายการนี้แล้ว" : "ไม่ยอมรับรายการนี้แล้ว",
      })
      await load()
    } catch (error) {
      if (isPermissionDenied(error as Error)) {
        setAccessDenied(true)
        return
      }
      setMessage({ type: "error", text: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง" })
    } finally {
      setSaving(false)
    }
  }

  const bulkAccept = async () => {
    setConfirmBulk(false)
    if (selected.length === 0) return
    setSaving(true)
    try {
      const response = await apiFetch("/api/v1/attendance/checkins/review-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selected, review_status: "ACCEPTED" }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setMessage({ type: "error", text: apiErrorMessage(body?.detail, "ยอมรับที่เลือกไม่สำเร็จ") })
        return
      }
      setMessage({
        type: "success",
        text: `ยอมรับแล้ว ${body.updated} รายการ${body.skipped ? ` · ข้าม ${body.skipped} รายการที่ไม่ได้รอตรวจ` : ""}`,
      })
      await load()
    } catch (error) {
      if (isPermissionDenied(error as Error)) {
        setAccessDenied(true)
        return
      }
      setMessage({ type: "error", text: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง" })
    } finally {
      setSaving(false)
    }
  }

  const toggleRow = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))
  }

  /**
   * Download the CSV. The bytes come through `apiFetch` so the session cookie travels with the request
   * and a 401/403 behaves exactly like every other call on this page (the detail photo uses the same
   * route); the blob is turned into a temporary object URL and clicked, which is also how the photo is
   * shown. The file name mirrors what the backend sends in `Content-Disposition`.
   */
  const downloadExport = async () => {
    const from = thaiDateToIso(exportFrom)
    const to = thaiDateToIso(exportTo)
    if (!from || !to) {
      setExportMessage("รูปแบบวันที่ไม่ถูกต้อง ใช้ วว/ดด/ปปปป")
      return
    }
    if (from > to) {
      setExportMessage("ช่วงวันที่ไม่ถูกต้อง: วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด")
      return
    }
    setExportRunning(true)
    setExportMessage("")
    try {
      const params = new URLSearchParams({
        kind: exportKind,
        date_from: from,
        date_to: to,
        include_pending: String(exportPending),
        include_rejected: String(exportRejected),
      })
      // Task 061: the file must hold exactly the rows the filtered table shows, so the toolbar's location
      // filter travels with the export (the dialog's own date range stays independent, as before).
      if (filters.locationId) params.set("location_id", filters.locationId)
      const response = await apiFetch(`/api/v1/attendance/checkins/export?${params.toString()}`)
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        setExportMessage(apiErrorMessage(body?.detail, "ส่งออกไฟล์ไม่สำเร็จ"))
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `attendance-${exportKind}_${from}_${to}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setExportMessage("ดาวน์โหลดไฟล์แล้ว")
    } catch (error) {
      if (isPermissionDenied(error as Error)) {
        setAccessDenied(true)
        return
      }
      setExportMessage("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง")
    } finally {
      setExportRunning(false)
    }
  }

  const exportRangeInvalid = !thaiDateToIso(exportFrom) || !thaiDateToIso(exportTo)
    || (thaiDateToIso(exportFrom) as string) > (thaiDateToIso(exportTo) as string)

  /** Any change to the dialog's choices clears a message that belonged to the previous ones. */
  const touchExportChoices = () => setExportMessage("")

  const pendingOnPage = rows.filter((row) => row.review_status === "PENDING_REVIEW")
  const selectableOnPage = pendingOnPage.map((row) => row.id)
  const allSelected = selectableOnPage.length > 0 && selectableOnPage.every((id) => selected.includes(id))
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  /** The location filter as the export dialog names it, so the dialog and the toolbar can never disagree
   *  about what the downloaded file will contain. */
  const locationFilterLabel = (() => {
    if (!filters.locationId) return "ทุกสถานที่"
    const option = locationOptions.find((item) => (item.location_id ?? "none") === filters.locationId)
    if (option) return option.location_name
    return filters.locationId === "none" ? "ไม่ระบุสถานที่" : filters.locationId
  })()

  /** How many *hidden* advanced filters are narrowing the list — shown on the toggle button. */
  const activeFilterCount = [
    filters.flag !== "",
    filters.timeStatus !== "",
    filters.locationStatus !== "",
    flaggedOnly,
  ].filter(Boolean).length

  /** Only a range that covers more than one day needs the date under the time (Amendment 1). */
  const spansMultipleDays = filters.dateFrom !== filters.dateTo

  const chips: { key: ReviewStatus | ""; label: string; count: number }[] = summary
    ? [
        { key: "", label: "ทั้งหมด", count: summary.total },
        { key: "CLEAN", label: REVIEW_LABEL.CLEAN, count: summary.by_review_status.CLEAN ?? 0 },
        { key: "PENDING_REVIEW", label: REVIEW_LABEL.PENDING_REVIEW, count: summary.by_review_status.PENDING_REVIEW ?? 0 },
        { key: "ACCEPTED", label: REVIEW_LABEL.ACCEPTED, count: summary.by_review_status.ACCEPTED ?? 0 },
        { key: "REJECTED", label: REVIEW_LABEL.REJECTED, count: summary.by_review_status.REJECTED ?? 0 },
      ]
    : []

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">รายการลงเวลา</h1>
          <p className="text-sm font-bold text-base-content/60">
            ดูหลักฐานการลงเวลาและตรวจรายการที่มีธง
          </p>
          <p className="text-[11px] text-base-content/50 mt-1">
            การลงเวลาถูกบันทึกไว้เสมอ ไม่มีการบล็อก — ฝ่ายบุคคลเป็นผู้ตัดสินใจทีหลังตรงนี้
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="self-start md:self-auto flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          โหลดใหม่
        </button>
      </div>

      {message.text && (
        <div className="flex items-center gap-3 px-6 py-4 rounded-xl border bg-base-200 border-base-300 text-base-content animate-in fade-in slide-in-from-top-4 duration-300">
          {message.type === "success" ? (
            <CheckCircle2 size={18} className="text-success shrink-0" />
          ) : (
            <AlertCircle size={18} className="text-error shrink-0" />
          )}
          <span className="text-sm font-bold tracking-tight">{message.text}</span>
          <button
            onClick={() => setMessage({ type: "success", text: "" })}
            className="ml-auto text-base-content/40 hover:text-base-content cursor-pointer"
            aria-label="ปิดข้อความ"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Summary chips double as quick filters */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => {
            const active = filters.reviewStatus === chip.key
            return (
              <button
                key={chip.key || "all"}
                onClick={() => {
                  setFilters((current) => ({ ...current, reviewStatus: chip.key }))
                  setPage(1)
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black border transition-all cursor-pointer ${
                  active
                    ? "bg-primary text-primary-content border-primary"
                    : "bg-base-100 border-base-300 text-base-content/70 hover:bg-base-200"
                }`}
              >
                {chip.label} · {chip.count}
              </button>
            )
          })}
        </div>
      )}

      <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm">
        {/* Toolbar */}
        <div className="p-4 border-b border-base-300 flex flex-col gap-3 bg-base-200/40">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={16} />
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setFilters((current) => ({ ...current, q: searchInput }))
                    setPage(1)
                  }
                }}
                placeholder="ค้นหารหัสพนักงานหรือชื่อ..."
                className="w-full bg-base-100 border border-base-300/60 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <button
              onClick={() => {
                setFilters((current) => ({ ...current, q: searchInput }))
                setPage(1)
              }}
              className="px-4 py-2.5 rounded-xl bg-primary text-primary-content text-sm font-black hover:opacity-90 transition-all cursor-pointer"
            >
              ค้นหา
            </button>
          </div>

          {/* Always visible: the date range. Everything that narrows the list further lives behind
              "ตัวกรองเพิ่มเติม" (Amendment 1), whose button shows a count while one of them is on. */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col items-start gap-1 text-xs font-black text-base-content/60">
              ตั้งแต่วันที่
              <input
                type="text"
                inputMode="numeric"
                placeholder="วว/ดด/ปปปป"
                value={fromText}
                onChange={(event) => {
                  const text = event.target.value
                  setFromText(text)
                  const iso = thaiDateToIso(text)
                  if (iso) {
                    setFilters((current) => ({ ...current, dateFrom: iso }))
                    setPage(1)
                  }
                }}
                onBlur={() => {
                  // An unparseable box snaps back to the date the query is actually using.
                  if (!thaiDateToIso(fromText)) setFromText(isoToThaiDate(filters.dateFrom))
                }}
                className="w-full sm:w-32 bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </label>
            <label className="flex flex-col items-start gap-1 text-xs font-black text-base-content/60">
              ถึงวันที่
              <input
                type="text"
                inputMode="numeric"
                placeholder="วว/ดด/ปปปป"
                value={toText}
                onChange={(event) => {
                  const text = event.target.value
                  setToText(text)
                  const iso = thaiDateToIso(text)
                  if (iso) {
                    setFilters((current) => ({ ...current, dateTo: iso }))
                    setPage(1)
                  }
                }}
                onBlur={() => {
                  if (!thaiDateToIso(toText)) setToText(isoToThaiDate(filters.dateTo))
                }}
                className="w-full sm:w-32 bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </label>
            <button
              onClick={() => {
                setFromText(isoToThaiDate(today))
                setToText(isoToThaiDate(today))
                setFilters((current) => ({ ...current, dateFrom: today, dateTo: today }))
                setPage(1)
              }}
              className="px-3 py-2 rounded-xl border border-base-300 text-xs font-black hover:bg-base-200 transition-colors cursor-pointer"
            >
              วันนี้
            </button>
            <label className="flex flex-col items-start gap-1 text-xs font-black text-base-content/60">
              สถานที่
              <select
                value={filters.locationId}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, locationId: event.target.value }))
                  setPage(1)
                }}
                className="w-full sm:w-52 bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
              >
                <option value="">ทุกสถานที่</option>
                {locationOptions.map((option) => (
                  <option key={option.location_id ?? "none"} value={option.location_id ?? "none"}>
                    {option.location_name}
                  </option>
                ))}
              </select>
              {locationOptionsFailed && (
                <span className="text-[10px] font-bold text-warning">โหลดรายชื่อสถานที่ไม่สำเร็จ</span>
              )}
            </label>
            <button
              onClick={() => {
                setExportOpen(true)
                setExportMessage("")
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border border-base-300 text-xs font-black hover:bg-base-200 transition-colors cursor-pointer"
            >
              <Download size={14} />
              ส่งออกไฟล์
            </button>
            <button
              onClick={() => setShowAdvanced((current) => !current)}
              aria-expanded={showAdvanced}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-black transition-colors cursor-pointer ${
                activeFilterCount > 0 ? "border-primary/40 text-primary" : "border-base-300 hover:bg-base-200"
              }`}
            >
              <SlidersHorizontal size={14} />
              ตัวกรองเพิ่มเติม
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {activeFilterCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-primary text-primary-content text-[10px] font-black">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>

          {/* Advanced filters, closed by default on every screen size. */}
          {showAdvanced && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <select
                value={filters.flag}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, flag: event.target.value }))
                  setPage(1)
                }}
                className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
              >
                <option value="">ทุกธง</option>
                {Object.entries(FLAG_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                value={filters.timeStatus}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, timeStatus: event.target.value }))
                  setPage(1)
                }}
                className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
              >
                <option value="">ทุกสถานะเวลา</option>
                {Object.entries(TIME_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                value={filters.locationStatus}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, locationStatus: event.target.value }))
                  setPage(1)
                }}
                className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
              >
                <option value="">ทุกสถานะตำแหน่ง</option>
                {Object.entries(LOCATION_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-base-300/60 bg-base-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flaggedOnly}
                  onChange={(event) => setFlaggedOnly(event.target.checked)}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <span className="text-xs font-black text-base-content/70 flex items-center gap-1">
                  <Filter size={12} /> เฉพาะที่มีธง
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Bulk bar */}
        {selected.length > 0 && (
          <div className="px-4 py-3 border-b border-base-300 bg-base-200/60 flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-base-content/70">เลือกไว้ {selected.length} รายการ</span>
            <button
              onClick={() => setConfirmBulk(true)}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-primary text-primary-content text-xs font-black hover:opacity-90 transition-all cursor-pointer disabled:opacity-50"
            >
              ยอมรับที่เลือก
            </button>
            <button
              onClick={() => setSelected([])}
              className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-100 transition-colors cursor-pointer"
            >
              ล้างการเลือก
            </button>
          </div>
        )}

        {/* Table (Amendment 1): only what HR needs to pick a row — the date sits under the time only
            when the range spans more than one day, and everything else is in the detail panel. */}
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[620px]">
            <thead className="bg-base-200/60 border-b border-base-300">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={selectableOnPage.length === 0}
                    onChange={(event) => setSelected(event.target.checked ? selectableOnPage : [])}
                    className="w-4 h-4 accent-primary cursor-pointer disabled:opacity-30"
                    aria-label="เลือกทุกรายการที่รอตรวจในหน้านี้"
                  />
                </th>
                <th className="px-4 py-3 text-[11px] font-black text-base-content/50 whitespace-nowrap">เวลา</th>
                <th className="px-4 py-3 text-[11px] font-black text-base-content/50 whitespace-nowrap">พนักงาน</th>
                <th className="px-4 py-3 text-[11px] font-black text-base-content/50 whitespace-nowrap">รอบ</th>
                <th className="px-4 py-3 text-[11px] font-black text-base-content/50 whitespace-nowrap">ผลการลงเวลา</th>
                <th className="px-4 py-3 text-[11px] font-black text-base-content/50 whitespace-nowrap">สถานะตรวจ</th>
                <th className="px-4 py-3 w-8" aria-label="เปิดรายละเอียด" />
              </tr>
            </thead>
            <tbody className="divide-y divide-base-300">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm font-bold text-base-content/50">
                    <Loader2 size={18} className="animate-spin inline-block mr-2" />
                    กำลังโหลด...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm font-bold text-base-content/50">
                    ไม่พบรายการลงเวลาในช่วงที่เลือก
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => openDetail(row)}
                    className="hover:bg-base-200/50 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      {row.review_status === "PENDING_REVIEW" ? (
                        <input
                          type="checkbox"
                          checked={selected.includes(row.id)}
                          onChange={() => toggleRow(row.id)}
                          className="w-4 h-4 accent-primary cursor-pointer"
                          aria-label={`เลือก ${row.employee_id}`}
                        />
                      ) : (
                        <span className="text-base-content/20">–</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-sm font-black text-base-content">{hhmm(row.checked_at)}</span>
                      {spansMultipleDays && (
                        <span className="ml-2 text-[11px] font-bold text-base-content/50">
                          {workDateText(row.work_date)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p
                        className="text-sm font-bold text-base-content truncate max-w-[180px]"
                        title={row.full_name ?? row.employee_id}
                      >
                        {row.full_name ?? row.employee_id}
                      </p>
                      <p className="text-[11px] text-base-content/50">{row.employee_id}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p
                        className="text-sm font-bold text-base-content truncate max-w-[160px]"
                        title={row.round_label ?? "-"}
                      >
                        {row.round_label ?? "-"}
                      </p>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {row.flags.length === 0 ? (
                        <span className="px-2.5 py-1 rounded-full text-[11px] font-black bg-success/10 text-success">
                          ปกติ
                        </span>
                      ) : (
                        <span
                          className="px-2.5 py-1 rounded-full text-[11px] font-black bg-amber-500/10 text-amber-600 cursor-help"
                          title={row.flags.map((flag) => FLAG_LABEL[flag] ?? flag).join(" · ")}
                        >
                          มีธง {row.flags.length}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-black ${REVIEW_CLASS[row.review_status]}`}>
                        {REVIEW_LABEL[row.review_status] ?? row.review_status}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-base-content/30">
                      <ChevronRight size={16} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Paging — the page size lives here, next to the pager (Amendment 1). */}
        <div className="px-4 py-3 border-t border-base-300 flex flex-wrap items-center justify-between gap-3 bg-base-200/40">
          <p className="text-xs font-bold text-base-content/60">
            ทั้งหมด {total} รายการ · หน้า {page} จาก {pageCount}
          </p>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value))
                setPage(1)
              }}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-1.5 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} รายการ/หน้า
                </option>
              ))}
            </select>
            <button
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || loading}
              className="p-2 rounded-lg border border-base-300 hover:bg-base-200 transition-colors cursor-pointer disabled:opacity-40"
              aria-label="หน้าก่อนหน้า"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              disabled={page >= pageCount || loading}
              className="p-2 rounded-lg border border-base-300 hover:bg-base-200 transition-colors cursor-pointer disabled:opacity-40"
              aria-label="หน้าถัดไป"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Detail + review */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs overflow-y-auto"
          onClick={closeDetail}
        >
          <div
            className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-3xl shadow-2xl my-4 animate-in fade-in zoom-in-95 duration-200"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 p-6 border-b border-base-300">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-base-200 flex items-center justify-center">
                  <ClipboardCheck size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="font-black text-base text-base-content">
                    {detail.full_name ?? detail.employee_id}
                  </h2>
                  <p className="text-xs text-base-content/50">
                    {detail.employee_id}
                    {detail.department ? ` · ${detail.department}` : ""} · {workDateText(detail.work_date)} · {hhmm(detail.checked_at)}
                  </p>
                </div>
              </div>
              <button
                onClick={closeDetail}
                className="p-2 rounded-lg hover:bg-base-200 transition-colors cursor-pointer"
                aria-label="ปิด"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {detailLoading && (
                <p className="text-xs font-bold text-base-content/50">
                  <Loader2 size={14} className="animate-spin inline-block mr-2" />
                  กำลังโหลดรายละเอียด...
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-2xl border border-base-300 p-4 space-y-2">
                  <p className="text-[10px] font-black text-base-content/40 uppercase tracking-widest">เวลาและรอบ</p>
                  <p className="text-sm font-bold text-base-content">
                    รอบ {detail.round_seq ?? "-"} · {detail.round_label ?? "-"}
                  </p>
                  <p className="text-xs text-base-content/60">
                    มาตรฐาน {detail.expected_time ?? "-"} · ลงเวลาได้ {detail.window_start ?? "-"}–{detail.window_end ?? "-"} ·
                    ผ่อนผัน {detail.grace_minutes ?? 0} นาที
                  </p>
                  <p className="text-xs text-base-content/60">แม่แบบ: {detail.template_name ?? "-"}</p>
                  <span
                    className={`inline-block px-2.5 py-1 rounded-full text-[11px] font-black ${
                      detail.time_status === "ON_TIME" ? "bg-success/10 text-success" : "bg-amber-500/10 text-amber-600"
                    }`}
                  >
                    {TIME_LABEL[detail.time_status] ?? detail.time_status}
                  </span>
                </div>

                <div className="rounded-2xl border border-base-300 p-4 space-y-2">
                  <p className="text-[10px] font-black text-base-content/40 uppercase tracking-widest">ตำแหน่ง</p>
                  <p className="text-sm font-bold text-base-content">
                    {LOCATION_LABEL[detail.location_status] ?? detail.location_status}
                    {detail.location_status === "OUTSIDE" ? distanceText(detail.distance_m) : ""}
                  </p>
                  <p className="text-xs text-base-content/60">
                    สถานที่ที่กำหนด: {detail.matched_location_name ?? "-"}
                  </p>
                  <p className="text-xs text-base-content/60">
                    ความแม่นยำ GPS: {detail.accuracy_m !== null ? `${Math.round(detail.accuracy_m)} ม.` : "ไม่มีข้อมูล"}
                  </p>
                  {detail.lat !== null && detail.lng !== null ? (
                    <a
                      href={`https://www.google.com/maps?q=${detail.lat},${detail.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-black text-info hover:underline"
                    >
                      <MapPin size={12} /> เปิดในแผนที่
                    </a>
                  ) : (
                    <p className="text-xs text-base-content/40">ไม่มีพิกัด</p>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-base-300 p-4 space-y-2">
                <p className="text-[10px] font-black text-base-content/40 uppercase tracking-widest">ธงที่ระบบติด</p>
                {detail.flags.length === 0 ? (
                  <p className="text-xs font-bold text-base-content/50">ไม่มีธง</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {detail.flags.map((flag) => (
                      <span key={flag} className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-600 text-[11px] font-black">
                        {FLAG_LABEL[flag] ?? flag}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-xs text-base-content/60">
                  สถานะรูป: {PHOTO_STATUS_LABEL[detail.photo_status] ?? detail.photo_status}
                  {detail.photo_required ? " · รอบนี้ต้องมีรูป" : " · รอบนี้ไม่บังคับรูป"}
                </p>
              </div>

              <div className="rounded-2xl border border-base-300 p-4">
                <p className="text-[10px] font-black text-base-content/40 uppercase tracking-widest mb-2">รูปหลักฐาน</p>
                {detail.photo_key === null ? (
                  <p className="text-xs font-bold text-base-content/50">ไม่มีรูปในรายการนี้</p>
                ) : photoState === "loading" ? (
                  <p className="text-xs font-bold text-base-content/50">
                    <Loader2 size={14} className="animate-spin inline-block mr-2" />
                    กำลังโหลดรูป...
                  </p>
                ) : photoState === "ready" && photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrl} alt="รูปหลักฐานการลงเวลา" className="max-h-[360px] rounded-2xl border border-base-300" />
                ) : (
                  <p className="text-xs font-bold text-error">ไม่พบไฟล์รูป</p>
                )}
              </div>

              <div className="rounded-2xl border border-base-300 p-4 space-y-1">
                <p className="text-[10px] font-black text-base-content/40 uppercase tracking-widest">ผลการตรวจสอบ</p>
                <p className="text-sm font-bold text-base-content">
                  <span className={`px-2.5 py-1 rounded-full text-[11px] font-black ${REVIEW_CLASS[detail.review_status]}`}>
                    {REVIEW_LABEL[detail.review_status] ?? detail.review_status}
                  </span>
                </p>
                {detail.reviewed_by && (
                  <p className="text-xs text-base-content/60">
                    ตรวจโดย {detail.reviewed_by} · {stamp(detail.reviewed_at)}
                  </p>
                )}
                {detail.review_note && <p className="text-xs text-base-content/60">เหตุผล: {detail.review_note}</p>}
                <p className="text-[11px] text-base-content/50 pt-1">
                  ยอมรับ = รายการนี้ถูกต้อง ธงอธิบายได้ · ไม่ยอมรับ = ไม่นับรายการนี้ (ต้องระบุเหตุผล)
                  การตรวจสอบไม่เปลี่ยนข้อมูลฝั่งพนักงานและไม่แจ้งเตือนพนักงาน
                </p>
              </div>

              {detail.review_status !== "CLEAN" && (
                <div className="space-y-3">
                  {rejectOpen ? (
                    <div className="space-y-2">
                      <label className="text-xs font-black text-base-content/70">
                        เหตุผลที่ไม่ยอมรับ (จำเป็น)
                      </label>
                      <textarea
                        value={rejectNote}
                        onChange={(event) => setRejectNote(event.target.value)}
                        maxLength={500}
                        rows={3}
                        className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                        placeholder="เช่น ลงเวลาจากต่างจังหวัด ไม่ได้อยู่ในพื้นที่ทำงาน"
                      />
                      <div className="flex gap-3">
                        <button
                          onClick={() => {
                            setRejectOpen(false)
                            setRejectNote("")
                          }}
                          className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                        >
                          ยกเลิก
                        </button>
                        <button
                          onClick={() => applyReview("REJECTED", rejectNote)}
                          disabled={saving || rejectNote.trim().length === 0}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-error text-error-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                        >
                          {saving && <Loader2 size={14} className="animate-spin" />}
                          ยืนยันไม่ยอมรับ
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-3">
                      <button
                        onClick={() => applyReview("ACCEPTED")}
                        disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                      >
                        {saving && <Loader2 size={14} className="animate-spin" />}
                        ยอมรับ
                      </button>
                      <button
                        onClick={() => setRejectOpen(true)}
                        disabled={saving}
                        className="flex-1 px-4 py-2.5 rounded-xl border border-error/40 text-error text-sm font-black hover:bg-error/10 transition-colors disabled:opacity-50 cursor-pointer"
                      >
                        ไม่ยอมรับ
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk confirm */}
      {confirmBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl p-6 space-y-4">
            <h2 className="font-black text-base text-base-content">ยอมรับที่เลือก</h2>
            <p className="text-sm text-base-content/70">
              จะยอมรับรายการที่รอตรวจ {selected.length} รายการว่าถูกต้อง รายการที่ไม่ได้รอตรวจจะถูกข้ามให้
              (การไม่ยอมรับต้องทำทีละรายการเพราะต้องระบุเหตุผล)
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmBulk(false)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                onClick={bulkAccept}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                ยืนยันยอมรับ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export dialog (task 024) */}
      {exportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs overflow-y-auto"
          onClick={() => setExportOpen(false)}
        >
          <div
            className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-lg shadow-2xl my-4 animate-in fade-in zoom-in-95 duration-200"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 p-6 border-b border-base-300">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-base-200 flex items-center justify-center">
                  <Download size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="font-black text-base text-base-content">ส่งออกไฟล์</h2>
                  <p className="text-xs text-base-content/50">ไฟล์ CSV สำหรับส่งฝ่ายเงินเดือน</p>
                </div>
              </div>
              <button
                onClick={() => setExportOpen(false)}
                className="p-2 rounded-lg hover:bg-base-200 transition-colors cursor-pointer"
                aria-label="ปิด"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <div className="space-y-2">
                <p className="text-xs font-black text-base-content/60">ชนิดไฟล์</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="flex items-start gap-2 px-3 py-2.5 rounded-xl border border-base-300 cursor-pointer hover:bg-base-200 transition-colors">
                    <input
                      type="radio"
                      name="export-kind"
                      checked={exportKind === "detail"}
                      onChange={() => {
                        setExportKind("detail")
                        touchExportChoices()
                      }}
                      className="mt-0.5 accent-primary cursor-pointer"
                    />
                    <span className="text-xs font-bold text-base-content">
                      รายละเอียดรายการ
                      <span className="block text-[11px] font-medium text-base-content/50">หนึ่งแถวต่อการลงเวลาหนึ่งครั้ง</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 px-3 py-2.5 rounded-xl border border-base-300 cursor-pointer hover:bg-base-200 transition-colors">
                    <input
                      type="radio"
                      name="export-kind"
                      checked={exportKind === "daily"}
                      onChange={() => {
                        setExportKind("daily")
                        touchExportChoices()
                      }}
                      className="mt-0.5 accent-primary cursor-pointer"
                    />
                    <span className="text-xs font-bold text-base-content">
                      สรุปรายวัน
                      <span className="block text-[11px] font-medium text-base-content/50">หนึ่งแถวต่อพนักงานหนึ่งคนต่อหนึ่งวัน</span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-black text-base-content/60">ช่วงวันที่ (วว/ดด/ปปปป)</p>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col items-start gap-1 text-xs font-black text-base-content/60">
                    ตั้งแต่วันที่
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="วว/ดด/ปปปป"
                      value={exportFrom}
                      onChange={(event) => setExportFrom(event.target.value)}
                      className="w-full sm:w-32 bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                  </label>
                  <label className="flex flex-col items-start gap-1 text-xs font-black text-base-content/60">
                    ถึงวันที่
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="วว/ดด/ปปปป"
                      value={exportTo}
                      onChange={(event) => setExportTo(event.target.value)}
                      className="w-full sm:w-32 bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-black text-base-content/60">สถานที่</p>
                <p className="text-xs font-bold text-base-content/80">{locationFilterLabel}</p>
                <p className="text-[11px] text-base-content/50">
                  ไฟล์จะใช้ตัวกรองสถานที่เดียวกับตาราง — เปลี่ยนได้ที่แถบตัวกรองด้านบน
                </p>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-base-300/60 bg-base-100 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportPending}
                    onChange={(event) => {
                      setExportPending(event.target.checked)
                      touchExportChoices()
                    }}
                    className="w-4 h-4 accent-primary cursor-pointer"
                  />
                  <span className="text-xs font-black text-base-content/70">รวมรายการที่รอตรวจ</span>
                </label>
                <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-base-300/60 bg-base-100 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportRejected}
                    onChange={(event) => {
                      setExportRejected(event.target.checked)
                      touchExportChoices()
                    }}
                    className="w-4 h-4 accent-primary cursor-pointer"
                  />
                  <span className="text-xs font-black text-base-content/70">รวมรายการที่ไม่ยอมรับ</span>
                </label>
              </div>

              <div className="rounded-xl border border-base-300 bg-base-200/50 px-3 py-2.5 space-y-1">
                <p className="text-xs font-bold text-base-content/70">
                  {rangeCountsFailed
                    ? "อ่านจำนวนรายการในช่วงนี้ไม่ได้ในขณะนี้"
                    : rangeCounts === null
                      ? "กำลังนับรายการในช่วงนี้..."
                      : rangeCounts.total === 0
                        ? "ไม่มีรายการในช่วงนี้"
                        : `ในช่วงนี้มีทั้งหมด ${rangeCounts.total} รายการ · รอตรวจ ${rangeCounts.pending} รายการ`}
                </p>
                {!exportPending && rangeCounts !== null && rangeCounts.pending > 0 && (
                  <p className="text-[11px] text-base-content/50">รายการที่รอตรวจจะไม่ถูกรวมในไฟล์</p>
                )}
              </div>

              {exportMessage && (
                <p className={`text-xs font-bold ${exportMessage === "ดาวน์โหลดไฟล์แล้ว" ? "text-success" : "text-error"}`}>
                  {exportMessage}
                </p>
              )}

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  onClick={downloadExport}
                  disabled={exportRunning || exportRangeInvalid || (rangeCounts !== null && rangeCounts.total === 0)}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-content text-sm font-black hover:opacity-90 transition-all cursor-pointer disabled:opacity-50"
                >
                  {exportRunning ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {exportRunning ? "กำลังสร้างไฟล์..." : "ดาวน์โหลด CSV"}
                </button>
                <button
                  onClick={() => setExportOpen(false)}
                  className="px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                >
                  ปิด
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
