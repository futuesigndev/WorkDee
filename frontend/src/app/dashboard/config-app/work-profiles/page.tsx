"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, Home, Loader2, Pencil, Search, Users, X } from "lucide-react"
import { API_URL, apiFetch } from "@/lib/api"
import { isPermissionDenied } from "@/lib/errors"
import AccessDenied from "@/components/AccessDenied"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Ref {
  id: string
  name: string
}

interface WorkProfileRow {
  employee_id: string
  full_name: string
  department: string | null
  division: string | null
  company: string | null
  template: Ref | null
  location: Ref | null
  wfh_mode: boolean
  wfh_location: Ref | null
  updated_at: string | null
}

interface Filters {
  q: string
  department: string
  division: string
  company: string
  templateId: string
  locationId: string
  wfhOnly: boolean
  unassignedOnly: boolean
}

interface OptionsResponse {
  templates: Ref[]
  locations: (Ref & { code: string })[]
}

interface FilterOptions {
  department: string[]
  division: string[]
  company: string[]
}

interface SkippedRow {
  employee_id: string
  reason: string
}

interface BulkResult {
  matched: number
  updated: number
  unchanged: number
  skipped: SkippedRow[]
}

interface ApiErrorBody {
  detail?: string | { loc?: unknown[]; msg?: string }[]
}

/** Thai names for the API field names that can appear in a 422 (field names themselves never change). */
const FIELD_LABELS_TH: Record<string, string> = {
  employee_ids: "รายชื่อพนักงาน",
  filter: "ตัวกรอง",
  changes: "ค่าที่จะแก้ไข",
  template_id: "แม่แบบรอบลงเวลา",
  location_id: "สถานที่ทำงานหลัก",
  wfh_mode: "โหมด WFH",
  wfh_location_id: "จุดบ้าน (WFH)",
  page_size: "จำนวนต่อหน้า",
}

/**
 * Pydantic's own constraint messages arrive in English. The page mirrors the rules it can, so this is
 * only a safety net — map the common ones so HR never sees an English sentence.
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
  if (/Input should be a valid UUID/.test(message)) return "รูปแบบรหัสอ้างอิงไม่ถูกต้อง"
  if (/Input should be a valid list/.test(message)) return "ต้องเป็นรายการ"
  if (/List should have at most (\d+) items/.test(message)) {
    const items = message.match(/List should have at most (\d+) items/)
    return `เลือกได้ไม่เกิน ${items?.[1]} รายการ`
  }
  return message
}

const EMPTY_FILTERS: Filters = {
  q: "",
  department: "",
  division: "",
  company: "",
  templateId: "",
  locationId: "",
  wfhOnly: false,
  unassignedOnly: false,
}

/** 10 is the default from the spec; the values below 10 exist so paging can be exercised on a
 *  small tenant (and a `?page_size=` deep link may ask for anything from 1 to 100). */
const PAGE_SIZES = [10, 20, 25, 50]
const KEEP = "keep"
const CLEAR = "clear"

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
 * `updated_at` is timestamptz (UTC); HR reads it in Thai local time. The `th-TH` locale uses the
 * Buddhist Era and Asia/Bangkok here is explicit so the device time zone cannot change the reading.
 */
function formatBangkok(iso: string | null): string {
  if (!iso) return "—"
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return "—"
  const formatted = new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed)
  // th-TH gives "29 ก.ย. 2569 12:16"; Thai readers expect the clock suffix "น." as well.
  return `${formatted} น.`
}

/** True when anything narrows the list (used for the empty-state wording). */
function hasActiveFilters(filters: Filters): boolean {
  return Boolean(
    filters.q.trim() ||
      filters.department ||
      filters.division ||
      filters.company ||
      filters.templateId ||
      filters.locationId ||
      filters.wfhOnly ||
      filters.unassignedOnly,
  )
}

function filterQuery(filters: Filters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q.trim()) params.set("q", filters.q.trim())
  if (filters.department) params.set("department", filters.department)
  if (filters.division) params.set("division", filters.division)
  if (filters.company) params.set("company", filters.company)
  if (filters.templateId) params.set("template_id", filters.templateId)
  if (filters.locationId) params.set("location_id", filters.locationId)
  if (filters.wfhOnly) params.set("wfh", "true")
  if (filters.unassignedOnly) params.set("unassigned", "true")
  return params
}

/** Same filter, as the JSON body the bulk endpoint resolves server-side. */
function filterPayload(filters: Filters): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (filters.q.trim()) body.q = filters.q.trim()
  if (filters.department) body.department = filters.department
  if (filters.division) body.division = filters.division
  if (filters.company) body.company = filters.company
  if (filters.templateId) body.template_id = filters.templateId
  if (filters.locationId) body.location_id = filters.locationId
  if (filters.wfhOnly) body.wfh = true
  if (filters.unassignedOnly) body.unassigned = true
  return body
}

function currentValues(row: WorkProfileRow) {
  return {
    template_id: row.template?.id ?? null,
    location_id: row.location?.id ?? null,
    wfh_mode: row.wfh_mode,
    wfh_location_id: row.wfh_location?.id ?? null,
  }
}

/**
 * Client-side mirror of the server rules, used only to say how many selected employees will really
 * change. The server stays the source of truth (it re-resolves everything at call time).
 */
function predict(row: WorkProfileRow, changes: Record<string, unknown>): "changed" | "same" | "invalid" {
  const keys = Object.keys(changes)
  if (keys.length === 0) return "same"
  const current = currentValues(row)
  const next = { ...current }
  for (const key of keys) {
    if (key in next) (next as Record<string, unknown>)[key] = changes[key]
  }
  if (!("wfh_location_id" in changes) && next.wfh_mode === false) next.wfh_location_id = null
  if (next.wfh_mode && !next.wfh_location_id) return "invalid"
  if (!next.wfh_mode && next.wfh_location_id) return "invalid"
  return keys.some((key) => (current as Record<string, unknown>)[key] !== (next as Record<string, unknown>)[key])
    ? "changed"
    : "same"
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WorkProfilesPage() {
  const [rows, setRows] = useState<WorkProfileRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [message, setMessage] = useState({ type: "", text: "" })

  const [options, setOptions] = useState<OptionsResponse>({ templates: [], locations: [] })
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ department: [], division: [], company: [] })

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectAllMatching, setSelectAllMatching] = useState(false)
  // Every row we have ever seen, so the bulk confirmation can count real changes without a new call.
  const [seenRows, setSeenRows] = useState<Record<string, WorkProfileRow>>({})

  const [editing, setEditing] = useState<WorkProfileRow | null>(null)
  const [editForm, setEditForm] = useState({ templateId: "", locationId: "", wfh: false, wfhLocationId: "" })
  const [editError, setEditError] = useState("")
  const [saving, setSaving] = useState(false)

  const [showBulk, setShowBulk] = useState(false)
  const [bulkForm, setBulkForm] = useState({ template: KEEP, location: KEEP, wfh: KEEP, home: KEEP })
  const [bulkError, setBulkError] = useState("")
  const [bulkPending, setBulkPending] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage({ type: "", text: "" }), 6000)
  }

  const clearSelection = () => {
    setSelected(new Set())
    setSelectAllMatching(false)
  }

  const fetchProfiles = useCallback(async () => {
    setLoading(true)
    try {
      const params = filterQuery(filters)
      params.set("page", page.toString())
      params.set("page_size", pageSize.toString())
      const res = await apiFetch(`${API_URL}/api/v1/attendance/profiles?${params.toString()}`)
      if (res.ok) {
        const data = await res.json()
        const items: WorkProfileRow[] = data.items ?? []
        setSeenRows((previous) => {
          const next = { ...previous }
          items.forEach((item) => {
            next[item.employee_id] = item
          })
          return next
        })
        setRows(items)
        setTotal(data.total ?? 0)
      } else {
        const payload = await res.json().catch(() => null)
        showMessage("error", apiErrorMessage(payload, `ไม่สามารถโหลดข้อมูลโปรไฟล์การทำงานได้ (HTTP ${res.status})`))
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else showMessage("error", "ไม่สามารถโหลดข้อมูลโปรไฟล์การทำงานได้ — เซิร์ฟเวอร์ไม่ตอบสนอง")
    } finally {
      setLoading(false)
    }
  }, [filters, page, pageSize])

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      void fetchProfiles()
    }, 250)
    return () => clearTimeout(handle)
  }, [fetchProfiles])

  // `?page_size=N` deep link (QA / small tenants). Read after mount so SSR and the first client
  // render stay identical.
  useEffect(() => {
    const handle = setTimeout(() => {
      const requested = Number(new URLSearchParams(window.location.search).get("page_size"))
      if (Number.isInteger(requested) && requested >= 1 && requested <= 100) {
        setPageSize(requested)
        setPage(1)
      }
    }, 0)
    return () => clearTimeout(handle)
  }, [])

  useEffect(() => {
    const loadAux = async () => {
      try {
        const [optionsRes, filtersRes] = await Promise.all([
          apiFetch(`${API_URL}/api/v1/attendance/profiles/options`),
          apiFetch(`${API_URL}/api/v1/attendance/profiles/filters`),
        ])
        if (optionsRes.ok) {
          const data = await optionsRes.json()
          setOptions({ templates: data.templates ?? [], locations: data.locations ?? [] })
        } else if (optionsRes.status === 403) {
          setAccessDenied(true)
        }
        if (filtersRes.ok) {
          const data = await filtersRes.json()
          setFilterOptions({
            department: data.department ?? [],
            division: data.division ?? [],
            company: data.company ?? [],
          })
        }
      } catch (err) {
        if (isPermissionDenied(err)) setAccessDenied(true)
        // The dropdowns stay empty; the list itself still works and shows its own error state.
      }
    }
    void loadAux()
  }, [])

  // Any filter change restarts from page 1 and drops the selection (the set it referred to is gone).
  const updateFilters = (patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }))
    setPage(1)
    clearSelection()
  }

  const toggleRow = (employeeId: string) => {
    setSelectAllMatching(false)
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(employeeId)) next.delete(employeeId)
      else next.add(employeeId)
      return next
    })
  }

  const togglePage = () => {
    setSelectAllMatching(false)
    const pageIds = rows.map((row) => row.employee_id)
    setSelected((previous) => {
      const next = new Set(previous)
      const allSelected = pageIds.length > 0 && pageIds.every((id) => next.has(id))
      pageIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)))
      return next
    })
  }

  // ─── Edit one employee ────────────────────────────────────────────────────
  const openEdit = (row: WorkProfileRow) => {
    setEditing(row)
    setEditForm({
      templateId: row.template?.id ?? "",
      locationId: row.location?.id ?? "",
      wfh: row.wfh_mode,
      wfhLocationId: row.wfh_location?.id ?? "",
    })
    setEditError("")
  }

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || saving) return
    if (editForm.wfh && !editForm.wfhLocationId) {
      setEditError("การเปิดโหมด WFH ต้องระบุจุดบ้าน (WFH) — สร้างไว้ในหน้าสถานที่ทำงานก่อน")
      return
    }
    setSaving(true)
    setEditError("")
    try {
      const res = await apiFetch(`${API_URL}/api/v1/attendance/profiles/${editing.employee_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: editForm.templateId || null,
          location_id: editForm.locationId || null,
          wfh_mode: editForm.wfh,
          wfh_location_id: editForm.wfh ? editForm.wfhLocationId || null : null,
        }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setEditError(apiErrorMessage(payload, `บันทึกไม่สำเร็จ (HTTP ${res.status})`))
        return
      }
      const data = await res.json()
      showMessage("success", data.changed ? `บันทึกโปรไฟล์ของ ${editing.employee_id} แล้ว` : "ไม่มีการเปลี่ยนแปลง")
      setEditing(null)
      setSeenRows((previous) => {
        const next = { ...previous }
        delete next[editing.employee_id]
        return next
      })
      await fetchProfiles()
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else setEditError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      setSaving(false)
    }
  }

  // ─── Bulk ─────────────────────────────────────────────────────────────────
  const bulkChanges = useMemo(() => {
    const changes: Record<string, unknown> = {}
    if (bulkForm.template !== KEEP) changes.template_id = bulkForm.template === CLEAR ? null : bulkForm.template
    if (bulkForm.location !== KEEP) changes.location_id = bulkForm.location === CLEAR ? null : bulkForm.location
    if (bulkForm.wfh !== KEEP) changes.wfh_mode = bulkForm.wfh === "on"
    if (bulkForm.home !== KEEP) changes.wfh_location_id = bulkForm.home === CLEAR ? null : bulkForm.home
    return changes
  }, [bulkForm])

  const selectedIds = useMemo(() => Array.from(selected), [selected])
  const targetCount = selectAllMatching ? total : selectedIds.length

  /** For an explicit id selection we can count the real changes locally; a filter set we cannot. */
  const prediction = useMemo(() => {
    if (selectAllMatching) return null
    if (selectedIds.length === 0) return null
    if (Object.keys(bulkChanges).length === 0) return null
    let changed = 0
    let same = 0
    let invalid = 0
    let unknown = 0
    selectedIds.forEach((id) => {
      const row = seenRows[id]
      if (!row) {
        unknown += 1
        return
      }
      const verdict = predict(row, bulkChanges)
      if (verdict === "changed") changed += 1
      else if (verdict === "same") same += 1
      else invalid += 1
    })
    return { changed, same, invalid, unknown }
  }, [bulkChanges, selectedIds, selectAllMatching, seenRows])

  const openBulk = () => {
    setBulkForm({ template: KEEP, location: KEEP, wfh: KEEP, home: KEEP })
    setBulkError("")
    setBulkResult(null)
    setShowBulk(true)
  }

  const handleBulk = async () => {
    if (bulkPending) return
    if (Object.keys(bulkChanges).length === 0) {
      setBulkError("เลือกอย่างน้อยหนึ่งช่องที่ต้องการแก้")
      return
    }
    if (!selectAllMatching && selectedIds.length > 500) {
      setBulkError(
        `เลือกไว้ ${selectedIds.length} คน ซึ่งเกิน 500 คนต่อครั้ง — ให้ใช้ "เลือกทั้งหมดที่ตรงกัน" แทน`,
      )
      return
    }
    setBulkPending(true)
    setBulkError("")
    const body: Record<string, unknown> = { changes: bulkChanges }
    if (selectAllMatching) body.filter = filterPayload(filters)
    else body.employee_ids = selectedIds
    try {
      const res = await apiFetch(`${API_URL}/api/v1/attendance/profiles/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setBulkError(apiErrorMessage(payload, `กำหนดค่าหลายคนไม่สำเร็จ (HTTP ${res.status})`))
        return
      }
      const result: BulkResult = await res.json()
      setBulkResult(result)
      showMessage(
        "success",
        `กำหนดค่าเสร็จแล้ว — แก้ไข ${result.updated} คน ไม่เปลี่ยน ${result.unchanged} คน ข้าม ${result.skipped.length} คน`,
      )
      setSeenRows((previous) => {
        const next = { ...previous }
        selectedIds.forEach((id) => {
          delete next[id]
        })
        return next
      })
      clearSelection()
      await fetchProfiles()
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else setBulkError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      setBulkPending(false)
    }
  }

  if (accessDenied) return <AccessDenied />

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const lastRow = Math.min(page * pageSize, total)
  const pageIds = rows.map((row) => row.employee_id)
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const someOnPageSelected = pageIds.some((id) => selected.has(id))
  const pageSizes = Array.from(new Set([...PAGE_SIZES, pageSize])).sort((a, b) => a - b)
  const editTemplateMissing =
    editForm.templateId !== "" && !options.templates.some((item) => item.id === editForm.templateId)
  const editLocationMissing =
    editForm.locationId !== "" && !options.locations.some((item) => item.id === editForm.locationId)
  const editHomeMissing =
    editForm.wfhLocationId !== "" && !options.locations.some((item) => item.id === editForm.wfhLocationId)

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">โปรไฟล์การทำงาน</h1>
          <p className="text-base-content/50 font-bold text-[10px] uppercase tracking-widest">
            ใครทำงานที่ไหน และใช้โหมด WFH หรือไม่
          </p>
          <p className="text-[11px] text-base-content/50 mt-1">แสดงเฉพาะพนักงานที่ขึ้นทะเบียนไว้ในระบบแล้วเท่านั้น</p>
        </div>
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
        {/* Toolbar */}
        <div className="p-4 border-b border-base-300 flex flex-col gap-3 bg-base-200/40">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={16} />
              <input
                type="text"
                value={filters.q}
                onChange={(event) => updateFilters({ q: event.target.value })}
                placeholder="ค้นหารหัสพนักงานหรือชื่อ..."
                className="w-full bg-base-100 border border-base-300/60 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value))
                setPage(1)
              }}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size} รายการ/หน้า
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-3">
            <select
              value={filters.department}
              onChange={(event) => updateFilters({ department: event.target.value })}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="">ทุกแผนก</option>
              {filterOptions.department.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              value={filters.division}
              onChange={(event) => updateFilters({ division: event.target.value })}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="">ทุกฝ่าย</option>
              {filterOptions.division.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              value={filters.company}
              onChange={(event) => updateFilters({ company: event.target.value })}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="">ทุกบริษัท</option>
              {filterOptions.company.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              value={filters.templateId}
              onChange={(event) => updateFilters({ templateId: event.target.value })}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="">ทุกแม่แบบรอบลงเวลา</option>
              {options.templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              value={filters.locationId}
              onChange={(event) => updateFilters({ locationId: event.target.value })}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="">ทุกสถานที่ทำงาน</option>
              {options.locations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-base-300/60 bg-base-100 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.wfhOnly}
                onChange={(event) => updateFilters({ wfhOnly: event.target.checked })}
                className="w-4 h-4 accent-primary cursor-pointer"
              />
              <span className="text-xs font-black text-base-content/70">เฉพาะ WFH</span>
            </label>
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-base-300/60 bg-base-100 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.unassignedOnly}
                onChange={(event) => updateFilters({ unassignedOnly: event.target.checked })}
                className="w-4 h-4 accent-primary cursor-pointer"
              />
              <span className="text-xs font-black text-base-content/70">เฉพาะที่ยังไม่ได้กำหนด</span>
            </label>
          </div>
        </div>

        {/* Selection helpers */}
        {pageIds.length > 0 && allOnPageSelected && (selectAllMatching || total > rows.length) && (
          <div className="px-4 py-3 border-b border-base-300 bg-base-200/60 flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-base-content/70">
              {selectAllMatching
                ? `เลือกพนักงานทั้ง ${total} คนที่ตรงกับตัวกรองนี้แล้ว`
                : `เลือกทั้งหน้านี้แล้ว — มีพนักงาน ${total} คนที่ตรงกับตัวกรอง`}
            </span>
            {!selectAllMatching && (
              <button
                onClick={() => setSelectAllMatching(true)}
                className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-100 transition-colors cursor-pointer"
              >
                เลือกทั้งหมด {total} คนที่ตรงกับตัวกรองนี้
              </button>
            )}
            <button
              onClick={clearSelection}
              className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-100 transition-colors cursor-pointer"
            >
              ล้างการเลือก
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-base-200/40 border-b border-base-300 text-[10px] font-black uppercase text-base-content/40">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={togglePage}
                    aria-label="เลือกทั้งหน้า"
                    ref={(element) => {
                      if (element) element.indeterminate = !allOnPageSelected && someOnPageSelected
                    }}
                    className="w-4 h-4 accent-primary cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3">พนักงาน</th>
                <th className="px-4 py-3 hidden lg:table-cell">แผนก</th>
                <th className="px-4 py-3">แม่แบบรอบลงเวลา</th>
                <th className="px-4 py-3">สถานที่ทำงานหลัก</th>
                <th className="px-4 py-3">WFH</th>
                <th className="px-4 py-3 hidden md:table-cell">แก้ไขล่าสุด</th>
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
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-sm text-base-content/40 italic">
                    {hasActiveFilters(filters)
                      ? "ไม่พบพนักงานที่ตรงกับตัวกรองที่เลือก"
                      : "ยังไม่มีพนักงานที่ขึ้นทะเบียนไว้ในระบบ"}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.employee_id} className="hover:bg-base-200/30 transition-colors">
                    <td className="px-4 py-4">
                      <input
                        type="checkbox"
                        checked={selected.has(row.employee_id)}
                        onChange={() => toggleRow(row.employee_id)}
                        aria-label={`เลือก ${row.employee_id}`}
                        className="w-4 h-4 accent-primary cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <div className="text-sm font-black text-base-content">{row.full_name}</div>
                      <div className="font-mono text-[11px] text-base-content/50">{row.employee_id}</div>
                    </td>
                    <td className="px-4 py-4 text-xs text-base-content/60 hidden lg:table-cell">
                      {row.department ?? "—"}
                      {row.division ? <span className="text-base-content/40"> · {row.division}</span> : null}
                    </td>
                    <td className="px-4 py-4 text-xs font-bold text-base-content/70">{row.template?.name ?? "—"}</td>
                    <td className="px-4 py-4 text-xs font-bold text-base-content/70">{row.location?.name ?? "—"}</td>
                    <td className="px-4 py-4">
                      {row.wfh_mode ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-base-200 text-base-content/70 border border-base-300">
                          <Home size={11} />
                          {row.wfh_location?.name ?? "WFH"}
                        </span>
                      ) : (
                        <span className="text-[11px] text-base-content/40">ทำงานที่ออฟฟิศ</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-[11px] text-base-content/50 hidden md:table-cell">
                      <span title="เวลาประเทศไทย">{formatBangkok(row.updated_at)}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(row)}
                          title="แก้ไขโปรไฟล์การทำงาน"
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-primary/10 hover:text-primary text-base-content/40 transition-all cursor-pointer"
                        >
                          <Pencil size={15} />
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
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              ก่อนหน้า
            </button>
            <span className="text-[11px] font-bold text-base-content/50">
              หน้า {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              ถัดไป
            </button>
          </div>
        </div>
      </div>

      {/* Bulk bar */}
      {(selected.size > 0 || selectAllMatching) && (
        <div className="sticky bottom-4 z-30 flex flex-wrap items-center justify-between gap-3 px-5 py-3 rounded-2xl border border-base-300 bg-base-100 shadow-xl">
          <span className="flex items-center gap-2 text-sm font-black text-base-content">
            <Users size={16} className="text-primary" />
            {selectAllMatching ? `เลือกพนักงานที่ตรงกันทั้งหมด ${total} คนแล้ว` : `เลือกแล้ว ${selected.size} คน`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={clearSelection}
              className="px-3 py-2 rounded-xl border border-base-300 text-xs font-black hover:bg-base-200 transition-colors cursor-pointer"
            >
              ล้างการเลือก
            </button>
            <button
              onClick={openBulk}
              className="px-4 py-2 rounded-xl bg-primary text-primary-content text-xs font-black hover:opacity-90 transition-all cursor-pointer"
            >
              กำหนดให้พนักงานที่เลือก
            </button>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content">{editing.full_name}</h2>
                <p className="text-xs text-base-content/50 mt-0.5 font-mono">{editing.employee_id}</p>
              </div>
              <button
                onClick={() => {
                  setEditing(null)
                  setEditError("")
                }}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {editError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border bg-base-200 border-base-300 text-base-content">
                  <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
                  <span className="text-xs font-bold">{editError}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                  แม่แบบรอบลงเวลา
                </label>
                <select
                  value={editForm.templateId}
                  onChange={(event) => setEditForm({ ...editForm, templateId: event.target.value })}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
                >
                  <option value="">— ไม่กำหนด —</option>
                  {options.templates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                  {editTemplateMissing && (
                    <option value={editForm.templateId}>{editing.template?.name} (ปิดใช้งาน)</option>
                  )}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                  สถานที่ทำงานหลัก
                </label>
                <select
                  value={editForm.locationId}
                  onChange={(event) => setEditForm({ ...editForm, locationId: event.target.value })}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
                >
                  <option value="">— ไม่กำหนด —</option>
                  {options.locations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.code})
                    </option>
                  ))}
                  {editLocationMissing && (
                    <option value={editForm.locationId}>{editing.location?.name} (ปิดใช้งาน)</option>
                  )}
                </select>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editForm.wfh}
                  onChange={(event) => setEditForm({ ...editForm, wfh: event.target.checked })}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <span className="text-sm font-bold text-base-content/70">ทำงานที่บ้าน (ไม่มีสถานที่ทำงานประจำ)</span>
              </label>

              {editForm.wfh && (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    จุดบ้าน (WFH) ที่ใช้ลงเวลา
                  </label>
                  <select
                    value={editForm.wfhLocationId}
                    onChange={(event) => setEditForm({ ...editForm, wfhLocationId: event.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
                  >
                    <option value="">— เลือก —</option>
                    {options.locations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.code})
                      </option>
                    ))}
                    {editHomeMissing && (
                      <option value={editForm.wfhLocationId}>{editing.wfh_location?.name} (ปิดใช้งาน)</option>
                    )}
                  </select>
                  <p className="text-[11px] text-base-content/50 ml-1">
                    พิกัดจุดบ้านเป็นข้อมูลส่วนบุคคล — ให้สร้างในหน้าสถานที่ทำงานด้วยชื่อที่ชัดเจน และเฉพาะผู้ดูแลระบบที่มี
                    สิทธิ์เมนูสถานที่ทำงานเท่านั้นที่เห็นได้
                  </p>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null)
                    setEditError("")
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
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  บันทึก
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk modal */}
      {showBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content">
                  {bulkResult ? "ผลการกำหนดค่าหลายคน" : "กำหนดค่าให้พนักงานหลายคน"}
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">
                  {bulkResult
                    ? `พิจารณา ${bulkResult.matched} คน`
                    : selectAllMatching
                      ? `พนักงานทั้ง ${total} คนที่ตรงกับตัวกรองนี้`
                      : `เลือกไว้ ${selectedIds.length} คน`}
                </p>
              </div>
              <button
                onClick={() => setShowBulk(false)}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {bulkError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border bg-base-200 border-base-300 text-base-content">
                  <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
                  <span className="text-xs font-bold">{bulkError}</span>
                </div>
              )}

              {!bulkResult && (
                <p className="text-xs text-base-content/50">
                  ช่องใดที่ไม่ต้องการแก้ ให้เลือก “ไม่เปลี่ยนแปลง”
                </p>
              )}

              <div hidden={Boolean(bulkResult)} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    แม่แบบรอบลงเวลา
                  </label>
                  <select
                    value={bulkForm.template}
                    onChange={(event) => setBulkForm({ ...bulkForm, template: event.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold outline-none cursor-pointer"
                  >
                    <option value={KEEP}>ไม่เปลี่ยนแปลง</option>
                    <option value={CLEAR}>ล้างค่า (ไม่ใช้แม่แบบ)</option>
                    {options.templates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    สถานที่ทำงานหลัก
                  </label>
                  <select
                    value={bulkForm.location}
                    onChange={(event) => setBulkForm({ ...bulkForm, location: event.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold outline-none cursor-pointer"
                  >
                    <option value={KEEP}>ไม่เปลี่ยนแปลง</option>
                    <option value={CLEAR}>ล้างค่า (ไม่ระบุสถานที่)</option>
                    {options.locations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    โหมด WFH
                  </label>
                  <select
                    value={bulkForm.wfh}
                    onChange={(event) =>
                      setBulkForm((previous) => ({
                        ...previous,
                        wfh: event.target.value,
                        home: event.target.value === "off" ? KEEP : previous.home,
                      }))
                    }
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold outline-none cursor-pointer"
                  >
                    <option value={KEEP}>ไม่เปลี่ยนแปลง</option>
                    <option value="on">เปิด</option>
                    <option value="off">ปิด</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    จุดบ้าน (WFH)
                  </label>
                  <select
                    value={bulkForm.home}
                    onChange={(event) => setBulkForm({ ...bulkForm, home: event.target.value })}
                    disabled={bulkForm.wfh === "off"}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm font-bold outline-none cursor-pointer disabled:opacity-50"
                  >
                    <option value={KEEP}>ไม่เปลี่ยนแปลง</option>
                    <option value={CLEAR}>ล้างค่า</option>
                    {options.locations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.code})
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-base-content/50 ml-1">
                    พิกัดจุดบ้านเป็นข้อมูลส่วนบุคคล — เฉพาะผู้ดูแลระบบที่มีสิทธิ์เมนูสถานที่ทำงานเท่านั้นที่เห็นได้
                  </p>
                </div>

                {prediction && (
                  <div className="px-4 py-3 rounded-xl border border-base-300 bg-base-200/60 space-y-2">
                    <p className="text-xs font-bold text-base-content">
                      จะแก้ไข {prediction.changed} จาก {selectedIds.length} คนที่เลือกไว้
                      {prediction.same > 0 ? ` · อีก ${prediction.same} คนมีค่าเหมือนเดิมอยู่แล้ว` : ""}
                    </p>
                    {prediction.invalid > 0 && (
                      <p className="text-xs font-bold px-4 py-3 rounded-xl border bg-amber-50 border-amber-300 text-amber-900">
                        มีอีก {prediction.invalid} คนที่รับการเปลี่ยนแปลงนี้ไม่ได้ (เช่น เปิดโหมด WFH แต่ไม่มีจุดบ้าน) —
                        ระบบจะปฏิเสธทั้งคำขอและไม่บันทึกอะไรเลย
                      </p>
                    )}
                    {prediction.unknown > 0 && (
                      <p className="text-[11px] text-base-content/50">
                        มี {prediction.unknown} คนที่เลือกไว้แต่อยู่ในหน้าที่ยังไม่ได้โหลด — ระบบจะรายงานจำนวนจริงให้
                      </p>
                    )}
                  </div>
                )}
                {selectAllMatching && (
                  <p className="text-xs font-bold text-base-content/70">
                    เมื่อกดปุ่ม ระบบจะดึงพนักงานทั้ง {total} คนที่ตรงกับตัวกรองนี้ และรายงานว่ามีการแก้ไขจริงกี่คน
                  </p>
                )}
              </div>

              {bulkResult && (
                <div className="px-4 py-3 rounded-xl border border-base-300 bg-base-200/60 space-y-1">
                  <p className="text-xs font-black text-base-content">
                    ผลลัพธ์: แก้ไข {bulkResult.updated} · ไม่เปลี่ยน {bulkResult.unchanged} · ข้าม{" "}
                    {bulkResult.skipped.length} · พิจารณา {bulkResult.matched}
                  </p>
                  {bulkResult.skipped.length > 0 && (
                    <ul className="text-[11px] text-base-content/60 space-y-0.5">
                      {bulkResult.skipped.slice(0, 10).map((item) => (
                        <li key={item.employee_id}>
                          <span className="font-mono">{item.employee_id}</span> — {item.reason}
                        </li>
                      ))}
                      {bulkResult.skipped.length > 10 && <li>… และอีก {bulkResult.skipped.length - 10} คน</li>}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBulk(false)}
                  className={
                    bulkResult
                      ? "flex-1 px-4 py-2.5 rounded-xl bg-primary text-primary-content text-sm font-black hover:opacity-90 transition-all cursor-pointer"
                      : "flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                  }
                >
                  ปิด
                </button>
                {!bulkResult && (
                  <button
                    type="button"
                    onClick={handleBulk}
                    disabled={bulkPending || Object.keys(bulkChanges).length === 0 || targetCount === 0}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {bulkPending && <Loader2 size={14} className="animate-spin" />}
                    ใช้กับ {targetCount} คน
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
