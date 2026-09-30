"use client"

import React, { useCallback, useEffect, useState } from "react"
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Pencil,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react"
import { API_URL, apiFetch } from "@/lib/api"
import { isPermissionDenied } from "@/lib/errors"
import AccessDenied from "@/components/AccessDenied"

// ─── Types & helpers ─────────────────────────────────────────────────────────

interface TemplateRound {
  id: string
  seq: number
  label: string
  window_start: string
  expected_time: string
  window_end: string
  photo_required: boolean
}

interface AttendanceTemplate {
  id: string
  name: string
  description: string | null
  grace_minutes: number
  is_active: boolean
  round_count: number
  /** Profiles pointing at this template (task 016) — list endpoint only. */
  assigned_count?: number
  updated_at: string | null
  updated_by: string | null
  rounds: TemplateRound[]
}

interface RoundForm {
  label: string
  window_start: string
  expected_time: string
  window_end: string
  photo_required: boolean
}

interface TemplateForm {
  name: string
  description: string
  grace_minutes: string
  is_active: boolean
  rounds: RoundForm[]
}

interface ApiErrorBody {
  detail?: string | { loc?: unknown[]; msg?: string }[]
}

/** Thai names for the API field names that can appear in a 422 (field names themselves never change). */
const FIELD_LABELS_TH: Record<string, string> = {
  name: "ชื่อ",
  description: "รายละเอียด",
  grace_minutes: "เวลาผ่อนผัน",
  is_active: "สถานะใช้งาน",
  rounds: "รอบลงเวลา",
  label: "ชื่อรอบ",
  window_start: "เริ่มลงเวลาได้",
  expected_time: "เวลามาตรฐาน",
  window_end: "ลงเวลาได้ถึง",
  photo_required: "ต้องถ่ายรูป",
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
  if (/Input should be a valid list/.test(message)) return "ต้องเป็นรายการ"
  return message
}

const EMPTY_ROUND: RoundForm = {
  label: "",
  window_start: "08:00",
  expected_time: "08:30",
  window_end: "09:00",
  photo_required: true,
}

const EMPTY_FORM: TemplateForm = {
  name: "",
  description: "",
  grace_minutes: "0",
  is_active: true,
  rounds: [{ ...EMPTY_ROUND }],
}

const MIN_ROUNDS = 1
const MAX_ROUNDS = 10

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

/** Client-side mirror of the server round rules (rule 2 of the spec). */
function validate(form: TemplateForm): string | null {
  const name = form.name.trim()
  if (!name) return "กรุณากรอกชื่อแม่แบบ"
  if (name.length > 120) return "ชื่อแม่แบบต้องไม่เกิน 120 ตัวอักษร"
  if (form.description.trim().length > 300) return "รายละเอียดต้องไม่เกิน 300 ตัวอักษร"
  const grace = Number(form.grace_minutes)
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) {
    return "เวลาผ่อนผันต้องเป็นจำนวนเต็มระหว่าง 0 ถึง 240 นาที"
  }

  const rounds = form.rounds
  if (rounds.length < MIN_ROUNDS) return "แม่แบบต้องมีอย่างน้อย 1 รอบ"
  if (rounds.length > MAX_ROUNDS) return `แม่แบบหนึ่งอันมีได้ไม่เกิน ${MAX_ROUNDS} รอบ`

  for (let i = 0; i < rounds.length; i += 1) {
    const round = rounds[i]
    const label = round.label.trim()
    if (!label) return `รอบที่ ${i + 1}: กรุณากรอกชื่อรอบ`
    if (label.length > 80) return `รอบที่ ${i + 1}: ชื่อรอบต้องไม่เกิน 80 ตัวอักษร`
    if (!round.window_start || !round.expected_time || !round.window_end) {
      return `รอบที่ ${i + 1} (${label}): ต้องกรอกเวลาทั้งสามช่อง`
    }
    if (round.window_start >= round.window_end) {
      return `รอบที่ ${i + 1} (${label}): เริ่มลงเวลาได้ต้องอยู่ก่อนลงเวลาได้ถึง`
    }
    if (round.expected_time < round.window_start || round.expected_time > round.window_end) {
      return `รอบที่ ${i + 1} (${label}): เวลามาตรฐานต้องอยู่ในช่วงเวลาที่กำหนด`
    }
  }

  // "HH:MM" sorts chronologically, so a plain string sort gives the time order the server uses.
  const ordered = [...rounds].sort((a, b) => a.window_start.localeCompare(b.window_start))
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i - 1].window_end >= ordered[i].window_start) {
      return `รอบ "${ordered[i - 1].label.trim()}" และ "${ordered[i].label.trim()}" ซ้อนกัน — รอบถัดไปต้องเริ่มหลังเวลาสิ้นสุดของรอบก่อนหน้า`
    }
  }
  return null
}

export default function AttendanceTemplatesPage() {
  const [templates, setTemplates] = useState<AttendanceTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [message, setMessage] = useState({ type: "", text: "" })
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<AttendanceTemplate | null>(null)
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM)
  const [formError, setFormError] = useState("")
  const [saving, setSaving] = useState(false)

  const [confirmRow, setConfirmRow] = useState<AttendanceTemplate | null>(null)
  const [toggling, setToggling] = useState(false)

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage({ type: "", text: "" }), 5000)
  }

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/attendance/templates`)
      if (res.ok) {
        const data = await res.json()
        setTemplates(data.items ?? [])
      } else {
        const payload = await res.json().catch(() => null)
        showMessage("error", apiErrorMessage(payload, `ไม่สามารถโหลดข้อมูลแม่แบบรอบลงเวลาได้ (HTTP ${res.status})`))
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else showMessage("error", "ไม่สามารถโหลดข้อมูลแม่แบบรอบลงเวลาได้ — เซิร์ฟเวอร์ไม่ตอบสนอง")
    } finally {
      setLoading(false)
    }
  }, [])

  // Deferred by one macrotask on purpose: the state updates inside fetchTemplates must not run
  // synchronously in the effect body (react-hooks/set-state-in-effect), and this way the loading
  // state paints before the request starts. The Locations page uses the same pattern (debounced).
  useEffect(() => {
    const handle = setTimeout(() => {
      void fetchTemplates()
    }, 0)
    return () => clearTimeout(handle)
  }, [fetchTemplates])

  const openCreate = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, rounds: [{ ...EMPTY_ROUND }] })
    setFormError("")
    setShowModal(true)
  }

  const openEdit = (row: AttendanceTemplate) => {
    setEditing(row)
    setForm({
      name: row.name,
      description: row.description ?? "",
      grace_minutes: String(row.grace_minutes),
      is_active: row.is_active,
      rounds:
        row.rounds.length > 0
          ? row.rounds.map((r) => ({
              label: r.label,
              window_start: r.window_start,
              expected_time: r.expected_time,
              window_end: r.window_end,
              photo_required: r.photo_required,
            }))
          : [{ ...EMPTY_ROUND }],
    })
    setFormError("")
    setShowModal(true)
  }

  const updateRound = (index: number, patch: Partial<RoundForm>) => {
    setForm((prev) => ({
      ...prev,
      rounds: prev.rounds.map((round, i) => (i === index ? { ...round, ...patch } : round)),
    }))
  }

  const addRound = () => {
    setForm((prev) =>
      prev.rounds.length >= MAX_ROUNDS ? prev : { ...prev, rounds: [...prev.rounds, { ...EMPTY_ROUND }] },
    )
  }

  const removeRound = (index: number) => {
    setForm((prev) => ({ ...prev, rounds: prev.rounds.filter((_, i) => i !== index) }))
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    const problem = validate(form)
    if (problem) {
      setFormError(problem)
      return
    }
    setSaving(true)
    setFormError("")
    const body = {
      name: form.name.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      grace_minutes: Number(form.grace_minutes),
      is_active: form.is_active,
      rounds: form.rounds.map((round) => ({
        label: round.label.trim(),
        window_start: round.window_start,
        expected_time: round.expected_time,
        window_end: round.window_end,
        photo_required: round.photo_required,
      })),
    }
    try {
      const res = await apiFetch(
        editing
          ? `${API_URL}/api/v1/attendance/templates/${editing.id}`
          : `${API_URL}/api/v1/attendance/templates`,
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
      showMessage("success", editing ? "บันทึกการแก้ไขแม่แบบแล้ว" : "เพิ่มแม่แบบแล้ว")
      setShowModal(false)
      setEditing(null)
      await fetchTemplates()
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
      const res = await apiFetch(`${API_URL}/api/v1/attendance/templates/${confirmRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !confirmRow.is_active }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        showMessage("error", apiErrorMessage(payload, `แก้ไขไม่สำเร็จ (HTTP ${res.status})`))
      } else {
        showMessage("success", confirmRow.is_active ? "ปิดใช้งานแม่แบบแล้ว" : "เปิดใช้งานแม่แบบแล้ว")
        await fetchTemplates()
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">แม่แบบรอบลงเวลา</h1>
          <p className="text-base-content/50 font-bold text-[10px] uppercase tracking-widest">
            กำหนดรอบลงเวลาต่อวันและช่วงเวลาของแต่ละรอบ
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95 cursor-pointer"
        >
          <Plus size={16} />
          เพิ่มแม่แบบ
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
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-base-200/40 border-b border-base-300 text-[10px] font-black uppercase text-base-content/40">
              <tr>
                <th className="px-6 py-3 w-8" />
                <th className="px-4 py-3">ชื่อ</th>
                <th className="px-4 py-3">จำนวนรอบ</th>
                <th className="px-4 py-3">เวลาผ่อนผัน</th>
                <th className="px-4 py-3">จำนวนคนที่ใช้</th>
                <th className="px-4 py-3">สถานะ</th>
                <th className="px-6 py-3 text-right">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-300/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center">
                    <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                  </td>
                </tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-sm text-base-content/40 italic">
                    ยังไม่มีแม่แบบ — เริ่มเพิ่มอันแรกได้เลย
                  </td>
                </tr>
              ) : (
                templates.map((row) => (
                  <React.Fragment key={row.id}>
                    <tr className="hover:bg-base-200/30 transition-colors">
                      <td className="px-6 py-4">
                        <button
                          onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                          title="ดูรอบลงเวลา"
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-base-200 text-base-content/40 transition-colors cursor-pointer"
                        >
                          {expandedId === row.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                      </td>
                      <td className="px-4 py-4">
                        <div className="text-sm font-black text-base-content">{row.name}</div>
                        {row.description && (
                          <div className="text-[11px] text-base-content/50 mt-0.5">{row.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-4 text-xs font-bold text-base-content/70">
                        {row.round_count} รอบ
                      </td>
                      <td className="px-4 py-4 text-xs font-bold text-base-content/70">
                        {row.grace_minutes > 0 ? `${row.grace_minutes} นาที` : "—"}
                      </td>
                      <td className="px-4 py-4 text-xs font-bold text-base-content/70">
                        {row.assigned_count ?? 0}
                      </td>
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
                            title="แก้ไขแม่แบบ"
                            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-primary/10 hover:text-primary text-base-content/40 transition-all cursor-pointer"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => setConfirmRow(row)}
                            title={row.is_active ? "ปิดใช้งานแม่แบบ" : "เปิดใช้งานแม่แบบ"}
                            className={
                              row.is_active
                                ? "w-8 h-8 flex items-center justify-center rounded-lg hover:bg-error/10 hover:text-error text-base-content/40 transition-all cursor-pointer"
                                : "w-8 h-8 flex items-center justify-center rounded-lg hover:bg-success/10 hover:text-success text-base-content/40 transition-all cursor-pointer"
                            }
                          >
                            <Power size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === row.id && (
                      <tr className="bg-base-200/30">
                        <td colSpan={7} className="px-6 pb-5 pt-1">
                          {row.rounds.length === 0 ? (
                            <p className="text-xs text-base-content/40 italic">แม่แบบนี้ยังไม่มีรอบลงเวลา</p>
                          ) : (
                            <div className="space-y-2">
                              {row.rounds.map((round) => (
                                <div
                                  key={round.id}
                                  className="flex flex-wrap items-center gap-3 bg-base-100 border border-base-300 rounded-xl px-4 py-2.5"
                                >
                                  <span className="w-6 h-6 rounded-lg bg-base-200 flex items-center justify-center text-[10px] font-black text-base-content/60">
                                    {round.seq}
                                  </span>
                                  <span className="text-xs font-black text-base-content min-w-[6rem]">
                                    {round.label}
                                  </span>
                                  <span className="text-[11px] font-mono text-base-content/60 flex items-center gap-1">
                                    <Clock size={12} />
                                    {round.window_start}–{round.window_end}
                                  </span>
                                  <span className="text-[11px] font-mono text-base-content/60">
                                    มาตรฐาน {round.expected_time}
                                  </span>
                                  <span className="text-[10px] font-black uppercase tracking-wider text-base-content/50 flex items-center gap-1">
                                    <Camera size={12} />
                                    {round.photo_required ? "ต้องถ่ายรูป" : "ไม่ต้องถ่ายรูป"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content">
                  {editing ? `แก้ไข ${editing.name}` : "เพิ่มแม่แบบรอบลงเวลา"}
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">
                  เวลาทั้งหมดเป็นเวลาไทย (โซนเวลาไทย) และระบบเรียงลำดับรอบตามเวลาให้เอง
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

            <form onSubmit={handleSave} className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
              {formError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border bg-base-200 border-base-300 text-base-content">
                  <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
                  <span className="text-xs font-bold">{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    ชื่อแม่แบบ *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="กะปกติ 08:30–17:30"
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    เวลาผ่อนผัน (นาที)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={240}
                    value={form.grace_minutes}
                    onChange={(e) => setForm({ ...form, grace_minutes: e.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                  รายละเอียด
                </label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="ใช้กับพนักงานประจำสำนักงานใหญ่"
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                    รอบลงเวลา ({form.rounds.length}/{MAX_ROUNDS})
                  </label>
                  <button
                    type="button"
                    onClick={addRound}
                    disabled={form.rounds.length >= MAX_ROUNDS}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-base-300 text-xs font-black hover:bg-base-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Plus size={13} />
                    เพิ่มรอบ
                  </button>
                </div>

                <div className="space-y-3">
                  {form.rounds.map((round, index) => (
                    <div key={index} className="border border-base-300 rounded-2xl p-4 space-y-3 bg-base-200/30">
                      <div className="flex items-center gap-3">
                        <span className="w-6 h-6 rounded-lg bg-base-100 border border-base-300 flex items-center justify-center text-[10px] font-black text-base-content/50">
                          {index + 1}
                        </span>
                        <input
                          type="text"
                          value={round.label}
                          onChange={(e) => updateRound(index, { label: e.target.value })}
                          placeholder="เข้างาน"
                          className="flex-1 bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                        />
                        <button
                          type="button"
                          onClick={() => removeRound(index)}
                          disabled={form.rounds.length <= MIN_ROUNDS}
                          title="ลบรอบนี้"
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-error/10 hover:text-error text-base-content/40 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase tracking-wider text-base-content/40">
                            เริ่มลงเวลาได้
                          </label>
                          <input
                            type="time"
                            required
                            value={round.window_start}
                            onChange={(e) => updateRound(index, { window_start: e.target.value })}
                            className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-primary/20 outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase tracking-wider text-base-content/40">
                            เวลามาตรฐาน
                          </label>
                          <input
                            type="time"
                            required
                            value={round.expected_time}
                            onChange={(e) => updateRound(index, { expected_time: e.target.value })}
                            className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-primary/20 outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase tracking-wider text-base-content/40">
                            ลงเวลาได้ถึง
                          </label>
                          <input
                            type="time"
                            required
                            value={round.window_end}
                            onChange={(e) => updateRound(index, { window_end: e.target.value })}
                            className="w-full bg-base-100 border border-base-300/60 rounded-xl px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-primary/20 outline-none"
                          />
                        </div>
                        <label className="flex items-end gap-2 pb-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={round.photo_required}
                            onChange={(e) => updateRound(index, { photo_required: e.target.checked })}
                            className="w-4 h-4 accent-primary cursor-pointer"
                          />
                          <span className="text-xs font-bold text-base-content/70">ต้องถ่ายรูป</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <span className="text-sm font-bold text-base-content/70">ใช้งาน (กำหนดให้พนักงานได้)</span>
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
                  {editing ? "บันทึกการแก้ไข" : "เพิ่มแม่แบบ"}
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
                  <Power size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="font-black text-base text-base-content">
                    {confirmRow.is_active ? "ปิดใช้งานแม่แบบ" : "เปิดใช้งานแม่แบบ"}
                  </h2>
                  <p className="text-xs text-base-content/50">
                    {confirmRow.name} · {confirmRow.round_count} รอบ
                  </p>
                </div>
              </div>
              <p className="text-sm text-base-content/70">
                {confirmRow.is_active
                  ? "แม่แบบที่ปิดใช้งานจะกำหนดให้พนักงานใหม่ไม่ได้อีก ไม่มีการลบข้อมูล รอบลงเวลายังอยู่ครบ"
                  : "แม่แบบนี้จะกลับมากำหนดให้พนักงานได้อีกครั้ง"}
              </p>
              {confirmRow.is_active && (confirmRow.assigned_count ?? 0) > 0 && (
                <p className="text-xs font-bold px-4 py-3 rounded-xl border bg-amber-50 border-amber-300 text-amber-900">
                  มีพนักงาน {confirmRow.assigned_count} คนที่ใช้แม่แบบนี้อยู่ การปิดใช้งานยังคงการใช้งานไว้ แต่จะกำหนดให้
                  พนักงานคนใหม่ไม่ได้อีก
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
