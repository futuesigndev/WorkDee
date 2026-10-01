"use client"

import React, { useCallback, useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, MapPin, Pencil, Plus, Search, X } from "lucide-react"
import { API_URL, apiFetch } from "@/lib/api"
import { isPermissionDenied } from "@/lib/errors"
import AccessDenied from "@/components/AccessDenied"
import FieldError from "@/components/FieldError"

// ─── Types & helpers ─────────────────────────────────────────────────────────

interface AttendanceLocation {
  id: string
  code: string
  name: string
  address: string | null
  latitude: number
  longitude: number
  radius_meters: number
  is_active: boolean
  updated_at: string | null
  updated_by: string | null
  /** Work profiles pointing at this location, as workplace or home point (task 016) — list only. */
  assigned_count?: number
}

interface LocationForm {
  code: string
  name: string
  address: string
  latitude: string
  longitude: string
  radius_meters: string
  is_active: boolean
}

interface ApiErrorBody {
  detail?: string | { loc?: unknown[]; msg?: string }[]
}

/** Thai names for the API field names that can appear in a 422 (field names themselves never change). */
const FIELD_LABELS_TH: Record<string, string> = {
  code: "รหัสสถานที่",
  name: "ชื่อ",
  address: "ที่อยู่",
  latitude: "ละติจูด",
  longitude: "ลองจิจูด",
  radius_meters: "รัศมี (เมตร)",
  is_active: "สถานะใช้งาน",
}

/**
 * Pydantic's own constraint messages arrive in English. The page mirrors every rule client-side, so
 * these are only a safety net — map the ones we can so HR never sees an English sentence.
 */
function translateFieldMessage(rawMessage: string): string {
  const message = rawMessage.replace(/^Value error,\s*/, "")
  const atMost = message.match(/String should have at most (\d+) characters/)
  if (atMost) return `ความยาวต้องไม่เกิน ${atMost[1]} ตัวอักษร`
  const atLeast = message.match(/String should have at least (\d+) characters/)
  if (atLeast) return `ความยาวต้องมีอย่างน้อย ${atLeast[1]} ตัวอักษร`
  if (/Field required/.test(message)) return "ต้องกรอกข้อมูลช่องนี้"
  const greater = message.match(/Input should be greater than or equal to (-?[\d.]+)/)
  if (greater) return `ค่าต้องไม่น้อยกว่า ${greater[1]}`
  const less = message.match(/Input should be less than or equal to (-?[\d.]+)/)
  if (less) return `ค่าต้องไม่เกิน ${less[1]}`
  if (/Input should be a valid integer/.test(message)) return "ต้องเป็นจำนวนเต็ม"
  if (/Input should be a valid number/.test(message)) return "ต้องเป็นตัวเลข"
  if (/Input should be a valid boolean/.test(message)) return "ต้องเป็นค่าจริง/เท็จ"
  if (/Input should be a valid UUID/.test(message)) return "รูปแบบรหัสอ้างอิงไม่ถูกต้อง"
  return message
}

const EMPTY_FORM: LocationForm = {
  code: "",
  name: "",
  address: "",
  latitude: "",
  longitude: "",
  radius_meters: "150",
  is_active: true,
}

/** FastAPI validation errors arrive as a list; HTTPException messages arrive as a string. */
function apiErrorMessage(payload: unknown, fallback: string): string {
  const body = payload as ApiErrorBody | null
  const detail = body?.detail
  if (typeof detail === "string") return detail
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      const raw = Array.isArray(item?.loc) ? String(item.loc[item.loc.length - 1]) : "field"
      const field = FIELD_LABELS_TH[raw] ?? raw
      return `${field}: ${translateFieldMessage(item?.msg ?? "ไม่ถูกต้อง")}`
    })
    if (parts.length > 0) return parts.join(" · ")
  }
  return fallback
}

/**
 * A number typed into one of the three numeric fields, or `null` when the text is not one.
 *
 * A comma is accepted as the decimal separator (task 047/D16). Google Maps shows Thai coordinates as
 * `13,7563, 100,5018`, and a `type="number"` input silently *drops* the comma — `13,7563` becomes the
 * valid-looking but wrong `137563`. This is why the two coordinate inputs are plain text inputs now.
 */
function parseCoordinate(value: string): number | null {
  const normalised = value.trim().replace(",", ".")
  if (!normalised) return null
  const parsed = Number(normalised)
  return Number.isFinite(parsed) ? parsed : null
}

/** Per-field Thai messages for the numeric inputs — the shape `FieldError` renders (task 027's idiom). */
type LocationFieldErrors = { latitude?: string; longitude?: string; radius_meters?: string }

/**
 * Why latitude `999` used to produce **no request and no message at all** (the 044 defect D16): the
 * form relied on the browser's own constraint checking (`type="number"` together with `min`/`max`), so
 * an out-of-range value made the input `:invalid` and the submit event never fired — the Thai checks
 * below were never reached, and the only feedback was the browser's own transient bubble. The form is
 * `noValidate` now and the page answers every case itself, next to the field.
 */
function validateFields(form: LocationForm): LocationFieldErrors {
  const errors: LocationFieldErrors = {}

  const latitude = parseCoordinate(form.latitude)
  if (!form.latitude.trim()) errors.latitude = "กรุณากรอกละติจูด"
  else if (latitude === null) errors.latitude = "ละติจูดต้องเป็นตัวเลข"
  else if (latitude < -90 || latitude > 90) errors.latitude = "ละติจูดต้องอยู่ระหว่าง -90 ถึง 90"

  const longitude = parseCoordinate(form.longitude)
  if (!form.longitude.trim()) errors.longitude = "กรุณากรอกลองจิจูด"
  else if (longitude === null) errors.longitude = "ลองจิจูดต้องเป็นตัวเลข"
  else if (longitude < -180 || longitude > 180) errors.longitude = "ลองจิจูดต้องอยู่ระหว่าง -180 ถึง 180"

  const radius = parseCoordinate(form.radius_meters)
  if (!form.radius_meters.trim()) errors.radius_meters = "กรุณากรอกรัศมี"
  else if (radius === null || !Number.isInteger(radius)) errors.radius_meters = "รัศมีต้องเป็นจำนวนเต็ม"
  else if (radius < 10 || radius > 1000) errors.radius_meters = "รัศมีต้องอยู่ระหว่าง 10 ถึง 1000 เมตร"

  return errors
}

/** Mirrors the server-side limits so the admin sees the problem before the request. */
function validate(form: LocationForm): string | null {
  const code = form.code.trim()
  const name = form.name.trim()
  if (!code) return "กรุณากรอกรหัสสถานที่"
  if (code.length > 32) return "รหัสสถานที่ต้องไม่เกิน 32 ตัวอักษร"
  if (!name) return "กรุณากรอกชื่อสถานที่"
  if (name.length > 120) return "ชื่อสถานที่ต้องไม่เกิน 120 ตัวอักษร"
  if (form.address.trim().length > 300) return "ที่อยู่ต้องไม่เกิน 300 ตัวอักษร"
  // lat/long/radius are checked by `validateFields` so each message appears next to its own field.
  return null
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<AttendanceLocation[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState("")
  const [activeFilter, setActiveFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [message, setMessage] = useState({ type: "", text: "" })

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<AttendanceLocation | null>(null)
  const [form, setForm] = useState<LocationForm>(EMPTY_FORM)
  const [formError, setFormError] = useState("")
  const [fieldErrors, setFieldErrors] = useState<LocationFieldErrors>({})
  const [saving, setSaving] = useState(false)

  const [confirmRow, setConfirmRow] = useState<AttendanceLocation | null>(null)
  const [toggling, setToggling] = useState(false)

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage({ type: "", text: "" }), 5000)
  }

  const fetchLocations = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        q: search.trim(),
        page: page.toString(),
        page_size: pageSize.toString(),
      })
      if (activeFilter !== "all") params.set("active", activeFilter)
      const res = await apiFetch(`${API_URL}/api/v1/attendance/locations?${params.toString()}`)
      if (res.ok) {
        const data = await res.json()
        setLocations(data.items ?? [])
        setTotal(data.total ?? 0)
      } else {
        const payload = await res.json().catch(() => null)
        showMessage("error", apiErrorMessage(payload, `ไม่สามารถโหลดข้อมูลสถานที่ทำงานได้ (HTTP ${res.status})`))
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else showMessage("error", "ไม่สามารถโหลดข้อมูลสถานที่ทำงานได้ — เซิร์ฟเวอร์ไม่ตอบสนอง")
    } finally {
      setLoading(false)
    }
  }, [search, page, pageSize, activeFilter])

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      void fetchLocations()
    }, 250)
    return () => clearTimeout(handle)
  }, [fetchLocations])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError("")
    setFieldErrors({})
    setShowModal(true)
  }

  const openEdit = (row: AttendanceLocation) => {
    setEditing(row)
    setForm({
      code: row.code,
      name: row.name,
      address: row.address ?? "",
      latitude: String(row.latitude),
      longitude: String(row.longitude),
      radius_meters: String(row.radius_meters),
      is_active: row.is_active,
    })
    setFormError("")
    setFieldErrors({})
    setShowModal(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    const problem = validate(form)
    const fieldProblems = validateFields(form)
    if (problem || Object.keys(fieldProblems).length > 0) {
      setFormError(problem ?? "")
      setFieldErrors(fieldProblems)
      return
    }
    setSaving(true)
    setFormError("")
    setFieldErrors({})
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      address: form.address.trim() === "" ? null : form.address.trim(),
      // `parseCoordinate` (not `Number`) so a comma decimal separator arrives as a real number.
      latitude: parseCoordinate(form.latitude),
      longitude: parseCoordinate(form.longitude),
      radius_meters: parseCoordinate(form.radius_meters),
      is_active: form.is_active,
    }
    try {
      const res = await apiFetch(
        editing
          ? `${API_URL}/api/v1/attendance/locations/${editing.id}`
          : `${API_URL}/api/v1/attendance/locations`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setFormError(apiErrorMessage(payload, `บันทึกไม่สำเร็จ (HTTP ${res.status})`))
        return
      }
      showMessage("success", editing ? "บันทึกการแก้ไขสถานที่ทำงานแล้ว" : "เพิ่มสถานที่ทำงานแล้ว")
      setShowModal(false)
      setEditing(null)
      await fetchLocations()
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else setFormError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async () => {
    if (!confirmRow || toggling) return
    setToggling(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/attendance/locations/${confirmRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !confirmRow.is_active }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        showMessage("error", apiErrorMessage(payload, `แก้ไขไม่สำเร็จ (HTTP ${res.status})`))
      } else {
        showMessage("success", confirmRow.is_active ? "ปิดใช้งานสถานที่ทำงานแล้ว" : "เปิดใช้งานสถานที่ทำงานแล้ว")
        await fetchLocations()
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else showMessage("error", "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      setToggling(false)
      setConfirmRow(null)
    }
  }

  if (accessDenied) return <AccessDenied />

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const lastRow = Math.min(page * pageSize, total)

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">สถานที่ทำงาน</h1>
          <p className="text-base-content/50 font-bold text-[10px] uppercase tracking-widest">
            จุดที่พนักงานลงเวลาได้
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95 cursor-pointer"
        >
          <Plus size={16} />
          เพิ่มสถานที่ทำงาน
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
        </div>
      )}

      <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-base-300 flex flex-col sm:flex-row gap-3 bg-base-200/40">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={16} />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="ค้นหารหัสหรือชื่อสถานที่..."
              className="w-full bg-base-100 border border-base-300/60 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
          <select
            value={activeFilter}
            onChange={(e) => {
              setActiveFilter(e.target.value)
              setPage(1)
            }}
            className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
          >
            <option value="all">ทุกสถานะ</option>
            <option value="true">ใช้งานเท่านั้น</option>
            <option value="false">ปิดใช้งานเท่านั้น</option>
          </select>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(1)
            }}
            className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
          >
            <option value={10}>10 รายการ/หน้า</option>
            <option value={25}>25 รายการ/หน้า</option>
            <option value={50}>50 รายการ/หน้า</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-base-200/40 border-b border-base-300 text-[10px] font-black uppercase text-base-content/40">
              <tr>
                <th className="px-6 py-3">รหัสสถานที่</th>
                <th className="px-4 py-3">ชื่อ</th>
                <th className="px-4 py-3 hidden lg:table-cell">ที่อยู่</th>
                <th className="px-4 py-3">พิกัด</th>
                <th className="px-4 py-3">รัศมี</th>
                <th className="px-4 py-3">จำนวนคนที่ใช้</th>
                <th className="px-4 py-3">สถานะ</th>
                <th className="px-6 py-3 text-right">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-300/60">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center">
                    <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                  </td>
                </tr>
              ) : locations.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-sm text-base-content/40 italic">
                    {search.trim() || activeFilter !== "all"
                      ? "ไม่พบสถานที่ทำงานที่ตรงกับตัวกรอง"
                      : "ยังไม่มีสถานที่ทำงาน — เริ่มเพิ่มรายการแรกได้เลย"}
                  </td>
                </tr>
              ) : (
                locations.map((row) => (
                  <tr key={row.id} className="hover:bg-base-200/30 transition-colors">
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs font-bold bg-base-200 px-2 py-1 rounded-lg">{row.code}</span>
                    </td>
                    <td className="px-4 py-4 text-sm font-black text-base-content">{row.name}</td>
                    <td className="px-4 py-4 text-xs text-base-content/60 hidden lg:table-cell max-w-[18rem] truncate">
                      {row.address ?? "—"}
                    </td>
                    <td className="px-4 py-4 text-[11px] font-mono text-base-content/60">
                      {row.latitude.toFixed(6)}, {row.longitude.toFixed(6)}
                    </td>
                    <td className="px-4 py-4 text-xs font-bold text-base-content/70">{row.radius_meters} เมตร</td>
                    <td className="px-4 py-4 text-xs font-bold text-base-content/70">{row.assigned_count ?? 0}</td>
                    <td className="px-4 py-4">
                      <span
                        className={
                          row.is_active
                            ? "px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-success text-success-content"
                            : "px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-base-200 text-base-content/60"
                        }
                      >
                        {row.is_active ? "ใช้งาน" : "ปิดใช้งาน"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(row)}
                          title="แก้ไขสถานที่ทำงาน"
                          aria-label={`แก้ไขสถานที่ทำงาน ${row.name}`}
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-primary/10 hover:text-primary text-base-content/40 transition-all cursor-pointer"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => setConfirmRow(row)}
                          title={row.is_active ? "ปิดใช้งานสถานที่ทำงาน" : "เปิดใช้งานสถานที่ทำงาน"}
                          aria-label={row.is_active ? `ปิดใช้งานสถานที่ทำงาน ${row.name}` : `เปิดใช้งานสถานที่ทำงาน ${row.name}`}
                          className={
                            row.is_active
                              ? "w-8 h-8 flex items-center justify-center rounded-lg hover:bg-error/10 hover:text-error text-base-content/40 transition-all cursor-pointer"
                              : "w-8 h-8 flex items-center justify-center rounded-lg hover:bg-success/10 hover:text-success text-base-content/40 transition-all cursor-pointer"
                          }
                        >
                          <MapPin size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-4 border-t border-base-300 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="text-[11px] font-bold text-base-content/40">
            แสดง {firstRow}–{lastRow} จาก {total} รายการ
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              ก่อนหน้า
            </button>
            <span className="text-[11px] font-bold text-base-content/50">
              หน้า {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              ถัดไป
            </button>
          </div>
        </div>
      </div>

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content">
                  {editing ? `แก้ไข ${editing.code}` : "เพิ่มสถานที่ทำงาน"}
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">
                  พิกัดคือจุดศูนย์กลางของรัศมีลงเวลา
                </p>
              </div>
              <button
                onClick={() => {
                  setShowModal(false)
                  setEditing(null)
                  setFormError("")
                }}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSave} noValidate className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {formError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border bg-base-200 border-base-300 text-base-content">
                  <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
                  <span className="text-xs font-bold">{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    รหัสสถานที่ *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    placeholder="LOC-001"
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono uppercase"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    ชื่อสถานที่ *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="สำนักงานใหญ่"
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">ที่อยู่</label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="เลขที่ ถนน เขต จังหวัด"
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    ละติจูด *
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={form.latitude}
                    onChange={(e) => {
                      setForm({ ...form, latitude: e.target.value })
                      setFieldErrors((previous) => ({ ...previous, latitude: undefined }))
                    }}
                    placeholder="13.7563"
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                  />
                  <FieldError message={fieldErrors.latitude} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    ลองจิจูด *
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={form.longitude}
                    onChange={(e) => {
                      setForm({ ...form, longitude: e.target.value })
                      setFieldErrors((previous) => ({ ...previous, longitude: undefined }))
                    }}
                    placeholder="100.5018"
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                  />
                  <FieldError message={fieldErrors.longitude} />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                  รัศมี (เมตร) *
                </label>
                <input
                  type="number"
                  required
                  value={form.radius_meters}
                  onChange={(e) => {
                    setForm({ ...form, radius_meters: e.target.value })
                    setFieldErrors((previous) => ({ ...previous, radius_meters: undefined }))
                  }}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                />
                <FieldError message={fieldErrors.radius_meters} />
                <p className="text-[11px] text-base-content/50 ml-1">แนะนำ 100–150 เมตร</p>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <span className="text-sm font-bold text-base-content/70">ใช้งาน (ใช้ลงเวลาได้)</span>
              </label>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false)
                    setEditing(null)
                    setFormError("")
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {editing ? "บันทึกการแก้ไข" : "เพิ่มสถานที่ทำงาน"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Activate / deactivate confirmation */}
      {confirmRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-base-200 flex items-center justify-center">
                  <MapPin size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="font-black text-base text-base-content">
                    {confirmRow.is_active ? "ปิดใช้งานสถานที่ทำงาน" : "เปิดใช้งานสถานที่ทำงาน"}
                  </h2>
                  <p className="text-xs text-base-content/50">
                    {confirmRow.code} · {confirmRow.name}
                  </p>
                </div>
              </div>
              <p className="text-sm text-base-content/70">
                {confirmRow.is_active
                  ? "สถานที่ทำงานที่ปิดใช้งานจะไม่แสดงในรายการที่ใช้งานอยู่ ไม่มีการลบข้อมูล และเปิดใช้งานกลับได้ทุกเมื่อ"
                  : "สถานที่ทำงานนี้จะกลับมาใช้ลงเวลาได้อีกครั้ง และแสดงในรายการที่ใช้งานอยู่"}
              </p>
              {confirmRow.is_active && (confirmRow.assigned_count ?? 0) > 0 && (
                <p className="text-xs font-bold px-4 py-3 rounded-xl border bg-amber-50 border-amber-300 text-amber-900">
                  มีพนักงาน {confirmRow.assigned_count} คนที่ใช้สถานที่นี้ (เป็นสถานที่ทำงานหลักหรือจุดบ้าน) การปิดใช้งาน
                  ยังคงการใช้งานไว้ แต่จะกำหนดให้พนักงานคนใหม่ไม่ได้อีก
                </p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmRow(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  onClick={handleToggleActive}
                  disabled={toggling}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {toggling && <Loader2 size={14} className="animate-spin" />}
                  {confirmRow.is_active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
