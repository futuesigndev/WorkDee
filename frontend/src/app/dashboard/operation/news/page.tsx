"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, CheckCircle2, FileText, Loader2, Pencil, Plus, Search, X } from "lucide-react"
import { API_URL, apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"
import { isPermissionDenied } from "@/lib/errors"
import { formatThaiDate } from "@/lib/datetime"
import AccessDenied from "@/components/AccessDenied"
import FieldError from "@/components/FieldError"

/**
 * ข่าวสารองค์กร — the HR side of company news (task 036).
 *
 * Two tabs over one page: the news list (`ข่าว`) and the categories (`ประเภทข่าว`). The API is
 * `backend/app/news_router.py`; every route sits behind the `news` menu permission, so a session
 * without the grant gets the shared <AccessDenied /> page instead of a blank screen.
 *
 * Client-side rules mirror the server on purpose (the same thing the Locations / Menus pages do):
 *  - lengths are counted in **characters, not bytes** (`Array.from` = code points, exactly like
 *    Python's `len()` on the server, so a Thai combining mark counts as one character),
 *  - the list request carries no body — the dialog fetches the full item, which is also why opening
 *    a row can show a short spinner,
 *  - a category that an item already uses stays selectable for that item even after HR deactivated
 *    it (the server allows an unchanged category); it is only dropped from the choices for *new*
 *    items and for a re-categorisation.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** `GET /news` row (no body) and `GET /news/{id}` (with body) share this shape. */
interface NewsRow {
  id: string
  title: string
  category_id: string
  category_name: string
  status: string
  published_at: string | null
  withdrawn_at: string | null
  created_at: string | null
  updated_at: string | null
  created_by: string | null
  updated_by: string | null
  body?: string
}

interface CategoryRow {
  id: string
  name: string
  sort_order: number
  is_active: boolean
  created_at: string | null
  updated_at: string | null
  /** How many news items (any status) use this category — list only. */
  news_count?: number
}

interface NewsForm {
  title: string
  body: string
  category_id: string
}

interface CategoryForm {
  name: string
  sort_order: string
  is_active: boolean
}

interface ApiErrorBody {
  detail?: string | { loc?: unknown[]; msg?: string }[]
}

/** Which lifecycle action is waiting for its Thai confirmation. */
type ConfirmKind = "publish" | "withdraw" | "delete"

// ─── Constants ───────────────────────────────────────────────────────────────

const TITLE_MAX = 150
const BODY_MAX = 5000
const NAME_MAX = 50
const SORT_ORDER_MAX = 99999

const STATUS_LABEL_TH: Record<string, string> = {
  DRAFT: "ฉบับร่าง",
  PUBLISHED: "เผยแพร่แล้ว",
  WITHDRAWN: "ถอนแล้ว",
}

/** Chip colours: a published item is the only one an employee can read, so it is the bold one. */
const STATUS_CLASS: Record<string, string> = {
  DRAFT: "bg-base-200 text-base-content/60",
  PUBLISHED: "bg-success text-success-content",
  WITHDRAWN: "bg-warning/15 text-warning",
}

const EMPTY_NEWS_FORM: NewsForm = { title: "", body: "", category_id: "" }
const EMPTY_CATEGORY_FORM: CategoryForm = { name: "", sort_order: "100", is_active: true }

/** Thai names for the API field names that can appear in a 422 (field names themselves never change). */
const FIELD_LABELS_TH: Record<string, string> = {
  title: "หัวข้อข่าว",
  body: "เนื้อข่าว",
  category_id: "ประเภทข่าว",
  name: "ชื่อประเภทข่าว",
  sort_order: "ลำดับ",
  is_active: "สถานะใช้งาน",
}

/**
 * Pydantic's constraint messages arrive in English. The page mirrors every rule client-side, so this
 * is only a safety net — map the ones we can so HR never reads an English sentence.
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
  if (/Input should be a valid UUID/.test(message)) return "รูปแบบรหัสอ้างอิงไม่ถูกต้อง"
  return message
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

/** The same count the server enforces: code points, so Thai combining marks count as characters. */
function charCount(value: string): number {
  return Array.from(value).length
}

/** Mirrors the server-side limits so HR sees the problem before the request is sent. */
function validateNews(form: NewsForm): { title?: string; body?: string; category_id?: string } {
  const problems: { title?: string; body?: string; category_id?: string } = {}
  const title = form.title.trim()
  const body = form.body.trim()
  if (!title) problems.title = "กรุณากรอกหัวข้อข่าว"
  else if (charCount(title) > TITLE_MAX) problems.title = `หัวข้อข่าวต้องไม่เกิน ${TITLE_MAX} ตัวอักษร`
  if (!body) problems.body = "กรุณากรอกเนื้อข่าว"
  else if (charCount(body) > BODY_MAX) problems.body = `เนื้อข่าวต้องไม่เกิน ${BODY_MAX} ตัวอักษร`
  if (!form.category_id) problems.category_id = "กรุณาเลือกประเภทข่าว"
  return problems
}

function validateCategory(form: CategoryForm): { name?: string; sort_order?: string } {
  const problems: { name?: string; sort_order?: string } = {}
  const name = form.name.trim()
  if (!name) problems.name = "กรุณากรอกชื่อประเภทข่าว"
  else if (charCount(name) > NAME_MAX) problems.name = `ชื่อประเภทข่าวต้องไม่เกิน ${NAME_MAX} ตัวอักษร`
  const order = Number(form.sort_order)
  if (form.sort_order.trim() === "" || !Number.isInteger(order) || order < 0 || order > SORT_ORDER_MAX) {
    problems.sort_order = `ลำดับต้องเป็นจำนวนเต็มระหว่าง 0 ถึง ${SORT_ORDER_MAX}`
  }
  return problems
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NewsPage() {
  const [activeTab, setActiveTab] = useState<"news" | "categories">("news")
  const [accessDenied, setAccessDenied] = useState(false)
  const [message, setMessage] = useState({ type: "", text: "" })

  // One counter per list: a slower, older response must not overwrite a newer one (the `fetchSeq`
  // guard of task 010/035). Sharing one ref would let a news refresh cancel a category refresh.
  const newsSeq = useRef(0)
  const categorySeq = useRef(0)
  const detailSeq = useRef(0)
  // `saving` disables the buttons, but that only takes effect on the next render. Two clicks
  // dispatched in the same tick would both pass the state check and send two write requests, so the
  // in-flight guard is the ref — a second click while one is running is dropped, not repeated.
  const newsSavingRef = useRef(false)
  const categorySavingRef = useRef(false)

  // ── News list ──
  const [items, setItems] = useState<NewsRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [statusFilter, setStatusFilter] = useState("all")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState("")

  // ── Categories ──
  const [categories, setCategories] = useState<CategoryRow[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(true)
  const [categoriesError, setCategoriesError] = useState("")

  // ── News dialog ──
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<NewsRow | null>(null)
  const [form, setForm] = useState<NewsForm>(EMPTY_NEWS_FORM)
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; body?: string; category_id?: string }>({})
  const [formError, setFormError] = useState("")
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null)

  // ── Category dialog ──
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<CategoryRow | null>(null)
  const [categoryForm, setCategoryForm] = useState<CategoryForm>(EMPTY_CATEGORY_FORM)
  const [categoryFieldErrors, setCategoryFieldErrors] = useState<{ name?: string; sort_order?: string }>({})
  const [categoryFormError, setCategoryFormError] = useState("")
  const [categorySaving, setCategorySaving] = useState(false)

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage({ type: "", text: "" }), 5000)
  }

  /**
   * Drop one field's inline error as soon as the admin edits that field. Validation runs on submit
   * (the forms are `noValidate`), so without this a field that has just been filled keeps the red
   * message from the previous attempt underneath it.
   */
  const clearNewsFieldError = (field: "title" | "body" | "category_id") => {
    setFieldErrors((previous) => (previous[field] ? { ...previous, [field]: undefined } : previous))
  }

  const clearCategoryFieldError = (field: "name" | "sort_order") => {
    setCategoryFieldErrors((previous) =>
      previous[field] ? { ...previous, [field]: undefined } : previous,
    )
  }

  /**
   * 403 anywhere on this page means "no `news` grant" — the page itself is off limits. Only the
   * handlers below use this; the two list loaders are `useCallback`s and inline the same two lines so
   * that their dependency lists stay exactly "the filters".
   */
  const handleFailure = (err: unknown, setError: (text: string) => void, fallback: string) => {
    if (isPermissionDenied(err)) setAccessDenied(true)
    else setError(fallback)
  }

  const loadNews = useCallback(async () => {
    const seq = ++newsSeq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (statusFilter !== "all") params.set("status", statusFilter)
      if (categoryFilter !== "all") params.set("category_id", categoryFilter)
      if (search.trim()) params.set("q", search.trim())
      const res = await apiFetch(`${API_URL}/api/v1/news?${params.toString()}`)
      if (seq !== newsSeq.current) return
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setListError("")
      } else {
        const payload = await res.json().catch(() => null)
        setListError(apiErrorMessage(payload, `โหลดข่าวไม่สำเร็จ (HTTP ${res.status})`))
      }
    } catch (err) {
      if (seq !== newsSeq.current) return
      if (isPermissionDenied(err)) setAccessDenied(true)
      else setListError("โหลดข่าวไม่สำเร็จ — เซิร์ฟเวอร์ไม่ตอบสนอง")
    } finally {
      if (seq === newsSeq.current) setLoading(false)
    }
  }, [page, pageSize, statusFilter, categoryFilter, search])

  const loadCategories = useCallback(async () => {
    const seq = ++categorySeq.current
    setCategoriesLoading(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/news/categories`)
      if (seq !== categorySeq.current) return
      if (res.ok) {
        const data = await res.json()
        setCategories(data.items ?? [])
        setCategoriesError("")
      } else {
        const payload = await res.json().catch(() => null)
        setCategoriesError(apiErrorMessage(payload, `โหลดประเภทข่าวไม่สำเร็จ (HTTP ${res.status})`))
      }
    } catch (err) {
      if (seq !== categorySeq.current) return
      if (isPermissionDenied(err)) setAccessDenied(true)
      else setCategoriesError("โหลดประเภทข่าวไม่สำเร็จ — เซิร์ฟเวอร์ไม่ตอบสนอง")
    } finally {
      if (seq === categorySeq.current) setCategoriesLoading(false)
    }
  }, [])

  // Debounced so typing in the search box does not fire a request per keystroke; the category list is
  // loaded through the same shape (a 0 ms timer) rather than called straight from the effect body.
  useEffect(() => {
    const handle = setTimeout(() => {
      void loadNews()
    }, 250)
    return () => clearTimeout(handle)
  }, [loadNews])

  useEffect(() => {
    const handle = setTimeout(() => {
      void loadCategories()
    }, 0)
    return () => clearTimeout(handle)
  }, [loadCategories])

  // ── News dialog ────────────────────────────────────────────────────────────

  const openCreate = () => {
    detailSeq.current += 1
    setEditing(null)
    setForm({ ...EMPTY_NEWS_FORM, category_id: categories.find((c) => c.is_active)?.id ?? "" })
    setFieldErrors({})
    setFormError("")
    setDetailLoading(false)
    setDialogOpen(true)
  }

  /** The list has no body, so the full item is fetched before the dialog is usable. */
  const openItem = async (row: NewsRow) => {
    const seq = ++detailSeq.current
    setEditing(row)
    setForm({ title: row.title, body: "", category_id: row.category_id })
    setFieldErrors({})
    setFormError("")
    setDetailLoading(true)
    setDialogOpen(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/news/${row.id}`)
      if (seq !== detailSeq.current) return
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setFormError(apiErrorMessage(payload, `โหลดข่าวไม่สำเร็จ (HTTP ${res.status})`))
        return
      }
      const data: NewsRow = await res.json()
      setEditing(data)
      setForm({ title: data.title, body: data.body ?? "", category_id: data.category_id })
      // The row in the table is now older than what the dialog shows (another admin may have edited
      // it), so the list is refreshed with the server's truth once the dialog has it.
      setItems((rows) => rows.map((item) => (item.id === data.id ? { ...item, ...data, body: undefined } : item)))
    } catch (err) {
      if (seq !== detailSeq.current) return
      handleFailure(err, setFormError, "โหลดข่าวไม่สำเร็จ — เซิร์ฟเวอร์ไม่ตอบสนอง")
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
  }

  const closeDialog = () => {
    detailSeq.current += 1
    setDialogOpen(false)
    setEditing(null)
    setConfirmKind(null)
    setFieldErrors({})
    setFormError("")
  }

  /**
   * Categories offered in the dialog: the active ones, plus the item's own category even when it was
   * deactivated in the meantime — the server accepts an unchanged category, and HR must still be able
   * to fix a typo on such an item.
   */
  const selectableCategories = categories.filter(
    (category) => category.is_active || category.id === editing?.category_id,
  )

  /** PATCHes the dialog's fields. Returns true on success so a lifecycle action can chain onto it. */
  const saveFields = async (): Promise<boolean> => {
    if (!editing) return false
    const res = await apiFetch(`${API_URL}/api/v1/news/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title.trim(),
        body: form.body.trim(),
        category_id: form.category_id,
      }),
    })
    if (!res.ok) {
      const payload = await res.json().catch(() => null)
      setFormError(apiErrorMessage(payload, `บันทึกไม่สำเร็จ (HTTP ${res.status})`))
      return false
    }
    return true
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newsSavingRef.current) return
    const problems = validateNews(form)
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) return
    newsSavingRef.current = true
    setSaving(true)
    setFormError("")
    try {
      if (!editing) {
        const res = await apiFetch(`${API_URL}/api/v1/news`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: form.title.trim(),
            body: form.body.trim(),
            category_id: form.category_id,
          }),
        })
        if (!res.ok) {
          const payload = await res.json().catch(() => null)
          setFormError(apiErrorMessage(payload, `บันทึกไม่สำเร็จ (HTTP ${res.status})`))
          return
        }
        showMessage("success", "บันทึกฉบับร่างแล้ว")
      } else if (!(await saveFields())) {
        return
      } else {
        showMessage("success", "บันทึกการแก้ไขแล้ว")
      }
      closeDialog()
      await loadNews()
    } catch (err) {
      handleFailure(err, setFormError, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      newsSavingRef.current = false
      setSaving(false)
    }
  }

  /**
   * Publish / withdraw / delete, all after their Thai confirmation. Publishing keeps what is in the
   * dialog (a draft HR just typed is saved first), so "publish" can never silently drop an edit.
   */
  const runConfirmedAction = async () => {
    if (!editing || !confirmKind || newsSavingRef.current) return
    const action = confirmKind
    setConfirmKind(null)
    newsSavingRef.current = true
    setSaving(true)
    setFormError("")
    try {
      if (action === "delete") {
        const res = await apiFetch(`${API_URL}/api/v1/news/${editing.id}`, { method: "DELETE" })
        if (!res.ok) {
          const payload = await res.json().catch(() => null)
          setFormError(apiErrorMessage(payload, `ลบไม่สำเร็จ (HTTP ${res.status})`))
          return
        }
        showMessage("success", "ลบฉบับร่างแล้ว")
        closeDialog()
        await loadNews()
        return
      }

      if (action === "publish") {
        const problems = validateNews(form)
        setFieldErrors(problems)
        if (Object.keys(problems).length > 0) return
        if (editing.status !== "PUBLISHED" && !(await saveFields())) return
      }

      const res = await apiFetch(`${API_URL}/api/v1/news/${editing.id}/${action}`, { method: "POST" })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setFormError(apiErrorMessage(payload, `ดำเนินการไม่สำเร็จ (HTTP ${res.status})`))
        return
      }
      const updated: NewsRow = await res.json()
      setEditing(updated)
      setForm({ title: updated.title, body: updated.body ?? form.body, category_id: updated.category_id })
      showMessage(
        "success",
        action === "publish"
          ? editing.status === "WITHDRAWN"
            ? "เผยแพร่ข่าวอีกครั้งแล้ว"
            : "เผยแพร่ข่าวแล้ว"
          : "ถอนข่าวแล้ว",
      )
      closeDialog()
      await loadNews()
    } catch (err) {
      handleFailure(err, setFormError, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      newsSavingRef.current = false
      setSaving(false)
    }
  }

  // ── Category dialog ────────────────────────────────────────────────────────

  const openCategoryCreate = () => {
    setEditingCategory(null)
    setCategoryForm(EMPTY_CATEGORY_FORM)
    setCategoryFieldErrors({})
    setCategoryFormError("")
    setCategoryDialogOpen(true)
  }

  const openCategoryEdit = (row: CategoryRow) => {
    setEditingCategory(row)
    setCategoryForm({ name: row.name, sort_order: String(row.sort_order), is_active: row.is_active })
    setCategoryFieldErrors({})
    setCategoryFormError("")
    setCategoryDialogOpen(true)
  }

  const handleCategorySave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (categorySavingRef.current) return
    const problems = validateCategory(categoryForm)
    setCategoryFieldErrors(problems)
    if (Object.keys(problems).length > 0) return
    categorySavingRef.current = true
    setCategorySaving(true)
    setCategoryFormError("")
    const body = {
      name: categoryForm.name.trim(),
      sort_order: Number(categoryForm.sort_order),
      is_active: categoryForm.is_active,
    }
    try {
      const res = await apiFetch(
        editingCategory
          ? `${API_URL}/api/v1/news/categories/${editingCategory.id}`
          : `${API_URL}/api/v1/news/categories`,
        {
          method: editingCategory ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setCategoryFormError(apiErrorMessage(payload, `บันทึกไม่สำเร็จ (HTTP ${res.status})`))
        return
      }
      showMessage("success", editingCategory ? "บันทึกการแก้ไขประเภทข่าวแล้ว" : "เพิ่มประเภทข่าวแล้ว")
      setCategoryDialogOpen(false)
      setEditingCategory(null)
      await loadCategories()
      // A category that was just deactivated must disappear from the news filter's options.
      if (categoryFilter !== "all") await loadNews()
    } catch (err) {
      handleFailure(err, setCategoryFormError, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
    } finally {
      categorySavingRef.current = false
      setCategorySaving(false)
    }
  }

  if (accessDenied) return <AccessDenied />

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const lastRow = Math.min(page * pageSize, total)
  const bodyLength = charCount(form.body)
  const categoryInUse = (editingCategory?.news_count ?? 0) > 0
  const filtered = search.trim() !== "" || statusFilter !== "all" || categoryFilter !== "all"

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">ข่าวสารองค์กร</h1>
          <p className="text-base-content/50 font-bold text-[10px] uppercase tracking-widest">
            ข่าวและประกาศของบริษัท
          </p>
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

      <div className="flex bg-base-200/50 p-1.5 rounded-xl gap-1 max-w-md shadow-inner">
        <button
          onClick={() => setActiveTab("news")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all cursor-pointer",
            activeTab === "news"
              ? "bg-base-100 text-primary shadow-sm"
              : "text-base-content/60 hover:text-base-content hover:bg-base-200/30",
          )}
        >
          <FileText size={14} />
          ข่าว
        </button>
        <button
          onClick={() => {
            setActiveTab("categories")
            // The in-use counts go stale while HR writes news on the other tab, so opening this tab
            // re-reads the categories instead of showing numbers from the first page load.
            void loadCategories()
          }}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all cursor-pointer",
            activeTab === "categories"
              ? "bg-base-100 text-primary shadow-sm"
              : "text-base-content/60 hover:text-base-content hover:bg-base-200/30",
          )}
        >
          <Pencil size={14} />
          ประเภทข่าว
        </button>
      </div>

      {activeTab === "news" ? (
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
                placeholder="ค้นหาหัวข้อข่าว..."
                className="w-full bg-base-100 border border-base-300/60 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value)
                setPage(1)
              }}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="all">ทุกสถานะ</option>
              <option value="DRAFT">ฉบับร่าง</option>
              <option value="PUBLISHED">เผยแพร่แล้ว</option>
              <option value="WITHDRAWN">ถอนแล้ว</option>
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value)
                setPage(1)
              }}
              className="bg-base-100 border border-base-300/60 rounded-xl px-3 py-2.5 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
            >
              <option value="all">ทุกประเภท</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.is_active ? category.name : `${category.name} (ปิดใช้งาน)`}
                </option>
              ))}
            </select>
            <button
              onClick={openCreate}
              className="flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95 cursor-pointer"
            >
              <Plus size={16} />
              เขียนข่าวใหม่
            </button>
          </div>

          {listError && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-6 py-4 border-b border-base-300 bg-error/10 text-error">
              <AlertCircle size={18} className="shrink-0" />
              <span className="text-sm font-bold tracking-tight flex-1">{listError}</span>
              <button
                type="button"
                onClick={() => void loadNews()}
                className="px-4 py-2 rounded-lg border border-error/40 text-xs font-black hover:bg-error/10 transition-colors cursor-pointer"
              >
                ลองอีกครั้ง
              </button>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-base-200/40 border-b border-base-300 text-[10px] font-black uppercase text-base-content/40">
                <tr>
                  <th className="px-6 py-3">หัวข้อข่าว</th>
                  <th className="px-4 py-3">ประเภท</th>
                  <th className="px-4 py-3">สถานะ</th>
                  <th className="px-4 py-3">วันที่</th>
                  <th className="px-6 py-3 text-right">เปิด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300/60">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center">
                      <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-sm text-base-content/40 italic">
                      {listError
                        ? "โหลดข่าวไม่สำเร็จ"
                        : filtered
                          ? "ไม่พบข่าวที่ตรงกับตัวกรอง"
                          : "ยังไม่มีข่าว — เริ่มเขียนข่าวแรกได้เลย"}
                    </td>
                  </tr>
                ) : (
                  items.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => void openItem(row)}
                      title="เปิดข่าวเพื่ออ่านหรือแก้ไข"
                      className="hover:bg-base-200/30 transition-colors cursor-pointer"
                    >
                      <td className="px-6 py-4 text-sm font-black text-base-content max-w-[26rem]">
                        <span className="block truncate">{row.title}</span>
                      </td>
                      <td className="px-4 py-4 text-xs font-bold text-base-content/70">
                        <span className="inline-block max-w-[12rem] truncate">{row.category_name}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={cn(
                            "px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider",
                            STATUS_CLASS[row.status] ?? "bg-base-200 text-base-content/60",
                          )}
                        >
                          {STATUS_LABEL_TH[row.status] ?? row.status}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-xs font-bold text-base-content/60">
                        {formatThaiDate(row.published_at ?? row.created_at)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Pencil size={15} className="inline-block text-base-content/30" />
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
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  setPage(1)
                }}
                className="bg-base-100 border border-base-300/60 rounded-lg px-2 py-1.5 text-[11px] font-bold focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer"
              >
                <option value={10}>10 รายการ/หน้า</option>
                <option value={25}>25 รายการ/หน้า</option>
                <option value={50}>50 รายการ/หน้า</option>
              </select>
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
      ) : (
        <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm">
          <div className="p-4 border-b border-base-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-base-200/40">
            <p className="text-xs font-bold text-base-content/50">
              ประเภทข่าวใช้จัดหมวดข่าว — ปิดใช้งานได้ แต่ลบไม่ได้ เพื่อไม่ให้ข่าวเดิมอ้างถึงประเภทที่หายไป
            </p>
            <button
              onClick={openCategoryCreate}
              className="flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95 cursor-pointer"
            >
              <Plus size={16} />
              เพิ่มประเภท
            </button>
          </div>

          {categoriesError && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-6 py-4 border-b border-base-300 bg-error/10 text-error">
              <AlertCircle size={18} className="shrink-0" />
              <span className="text-sm font-bold tracking-tight flex-1">{categoriesError}</span>
              <button
                type="button"
                onClick={() => void loadCategories()}
                className="px-4 py-2 rounded-lg border border-error/40 text-xs font-black hover:bg-error/10 transition-colors cursor-pointer"
              >
                ลองอีกครั้ง
              </button>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-base-200/40 border-b border-base-300 text-[10px] font-black uppercase text-base-content/40">
                <tr>
                  <th className="px-6 py-3">ชื่อประเภทข่าว</th>
                  <th className="px-4 py-3">ลำดับ</th>
                  <th className="px-4 py-3">จำนวนข่าว</th>
                  <th className="px-4 py-3">สถานะ</th>
                  <th className="px-6 py-3 text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300/60">
                {categoriesLoading ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center">
                      <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                    </td>
                  </tr>
                ) : categories.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-sm text-base-content/40 italic">
                      {categoriesError ? "โหลดประเภทข่าวไม่สำเร็จ" : "ยังไม่มีประเภทข่าว — เริ่มเพิ่มประเภทแรกได้เลย"}
                    </td>
                  </tr>
                ) : (
                  categories.map((row) => (
                    <tr key={row.id} className="hover:bg-base-200/30 transition-colors">
                      <td className="px-6 py-4 text-sm font-black text-base-content">{row.name}</td>
                      <td className="px-4 py-4 text-xs font-mono font-bold text-base-content/60">{row.sort_order}</td>
                      <td className="px-4 py-4 text-xs font-bold text-base-content/70">{row.news_count ?? 0}</td>
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
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => openCategoryEdit(row)}
                          title="แก้ไขประเภทข่าว"
                          className="w-8 h-8 inline-flex items-center justify-center rounded-lg hover:bg-primary/10 hover:text-primary text-base-content/40 transition-all cursor-pointer"
                        >
                          <Pencil size={15} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── News dialog ─────────────────────────────────────────────────────── */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs overflow-y-auto">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-2xl shadow-2xl my-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content">
                  {editing ? "แก้ไขข่าว" : "เขียนข่าวใหม่"}
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">
                  {editing
                    ? `${STATUS_LABEL_TH[editing.status] ?? editing.status} · แก้ไขล่าสุด ${formatThaiDate(editing.updated_at)}`
                    : "บันทึกเป็นฉบับร่างก่อน แล้วค่อยเผยแพร่ให้พนักงานอ่าน"}
                </p>
              </div>
              <button
                onClick={closeDialog}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSave} noValidate className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {formError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border bg-error/10 border-error/20 text-error">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span className="text-xs font-bold">{formError}</span>
                </div>
              )}

              {detailLoading ? (
                <div className="py-12 text-center">
                  <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                  <p className="text-xs font-bold text-base-content/40 mt-2">กำลังโหลดข่าว...</p>
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                      หัวข้อข่าว *
                    </label>
                    <input
                      type="text"
                      value={form.title}
                      onChange={(e) => {
                        setForm({ ...form, title: e.target.value })
                        clearNewsFieldError("title")
                      }}
                      maxLength={TITLE_MAX}
                      placeholder="เช่น ประกาศวันหยุดประจำปี"
                      className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-bold"
                    />
                    <FieldError message={fieldErrors.title} />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                      ประเภทข่าว *
                    </label>
                    <select
                      value={form.category_id}
                      onChange={(e) => {
                        setForm({ ...form, category_id: e.target.value })
                        clearNewsFieldError("category_id")
                      }}
                      className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-bold cursor-pointer"
                    >
                      <option value="">— เลือกประเภทข่าว —</option>
                      {selectableCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.is_active ? category.name : `${category.name} (ปิดใช้งาน)`}
                        </option>
                      ))}
                    </select>
                    <FieldError message={fieldErrors.category_id} />
                    {selectableCategories.length === 0 && (
                      <p className="text-[11px] font-bold text-warning ml-1">
                        ยังไม่มีประเภทข่าวที่ใช้งานอยู่ — เพิ่มที่แท็บ “ประเภทข่าว” ก่อน
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                        เนื้อข่าว *
                      </label>
                      <span
                        className={cn(
                          "text-[11px] font-black",
                          bodyLength > BODY_MAX ? "text-error" : "text-base-content/40",
                        )}
                      >
                        {bodyLength} / {BODY_MAX}
                      </span>
                    </div>
                    <textarea
                      value={form.body}
                      onChange={(e) => {
                        setForm({ ...form, body: e.target.value })
                        clearNewsFieldError("body")
                      }}
                      rows={10}
                      placeholder="พิมพ์ข้อความล้วน ๆ ได้เลย ขึ้นบรรทัดใหม่ได้ตามต้องการ"
                      className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium leading-relaxed max-w-full"
                    />
                    <FieldError message={fieldErrors.body} />
                  </div>

                  {/* Preview: exactly the plain text an employee will read — no HTML, no links. */}
                  <div className="space-y-2 pt-2 border-t border-base-300">
                    <p className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                      ตัวอย่างที่พนักงานจะเห็น
                    </p>
                    <div className="rounded-2xl border border-base-300 bg-base-200/40 p-4 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2.5 py-1 rounded-full text-[10px] font-black bg-primary text-primary-content">
                          {(categories.find((c) => c.id === form.category_id)?.name ?? "ไม่ระบุประเภท")
                            .replace(" (ปิดใช้งาน)", "")}
                        </span>
                        <span className="text-[10px] font-bold text-base-content/40">
                          {editing ? formatThaiDate(editing.published_at ?? editing.created_at) : "ยังไม่เผยแพร่"}
                        </span>
                      </div>
                      <p className="text-sm font-black text-base-content break-words">
                        {form.title.trim() === "" ? "ยังไม่ได้กรอกหัวข้อข่าว" : form.title.trim()}
                      </p>
                      <p className="text-sm text-base-content/80 whitespace-pre-wrap break-words">
                        {form.body.trim() === "" ? "ยังไม่ได้กรอกเนื้อข่าว" : form.body.trim()}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-3 pt-2">
                    {editing ? (
                      <>
                        <button
                          type="submit"
                          disabled={saving}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                        >
                          {saving && <Loader2 size={14} className="animate-spin" />}
                          {editing.status === "DRAFT" ? "บันทึกฉบับร่าง" : "บันทึกการแก้ไข"}
                        </button>
                        {editing.status !== "PUBLISHED" && (
                          <button
                            type="button"
                            onClick={() => setConfirmKind("publish")}
                            disabled={saving}
                            className="flex-1 px-4 py-2.5 rounded-xl border border-primary/40 text-primary text-sm font-black hover:bg-primary/10 transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            {editing.status === "DRAFT" ? "เผยแพร่" : "เผยแพร่อีกครั้ง"}
                          </button>
                        )}
                        {editing.status === "PUBLISHED" && (
                          <button
                            type="button"
                            onClick={() => setConfirmKind("withdraw")}
                            disabled={saving}
                            className="flex-1 px-4 py-2.5 rounded-xl border border-warning/40 text-warning text-sm font-black hover:bg-warning/10 transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            ถอนข่าว
                          </button>
                        )}
                        {editing.status === "DRAFT" && (
                          <button
                            type="button"
                            onClick={() => setConfirmKind("delete")}
                            disabled={saving}
                            className="flex-1 px-4 py-2.5 rounded-xl border border-error/40 text-error text-sm font-black hover:bg-error/10 transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            ลบฉบับร่าง
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        type="submit"
                        disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                      >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                        บันทึกฉบับร่าง
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={closeDialog}
                      className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                    >
                      ปิด
                    </button>
                  </div>
                </>
              )}
            </form>
          </div>
        </div>
      )}

      {/* ── Publish / withdraw / delete confirmation ─────────────────────────── */}
      {confirmKind && editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl p-6 space-y-4">
            <h2 className="font-black text-base text-base-content">
              {confirmKind === "publish"
                ? editing.status === "WITHDRAWN"
                  ? "ยืนยันเผยแพร่อีกครั้ง"
                  : "ยืนยันเผยแพร่ข่าว"
                : confirmKind === "withdraw"
                  ? "ยืนยันถอนข่าว"
                  : "ยืนยันลบฉบับร่าง"}
            </h2>
            <p className="text-sm text-base-content/70">
              {confirmKind === "publish"
                ? "เมื่อเผยแพร่แล้ว พนักงานที่ผูกบัญชี LINE ไว้จะอ่านข่าวนี้ได้"
                : confirmKind === "withdraw"
                  ? "ข่าวนี้จะไม่แสดงให้พนักงานเห็นอีก แต่ยังเก็บไว้และเผยแพร่ซ้ำได้"
                  : "ฉบับร่างนี้จะถูกลบถาวรและกู้คืนไม่ได้"}
            </p>
            <p className="text-xs font-bold text-base-content/50 truncate">{editing.title}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmKind(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                onClick={() => void runConfirmedAction()}
                disabled={saving}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black transition-all disabled:opacity-50 cursor-pointer",
                  confirmKind === "delete"
                    ? "bg-error text-error-content hover:opacity-90"
                    : "bg-primary text-primary-content hover:opacity-90",
                )}
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {confirmKind === "publish" ? "ยืนยันเผยแพร่" : confirmKind === "withdraw" ? "ยืนยันถอนข่าว" : "ยืนยันลบ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Category dialog ─────────────────────────────────────────────────── */}
      {categoryDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base-content/40 backdrop-blur-xs">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content">
                  {editingCategory ? "แก้ไขประเภทข่าว" : "เพิ่มประเภทข่าว"}
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">ประเภทข่าวใช้จัดหมวดข่าวของบริษัท</p>
              </div>
              <button
                onClick={() => {
                  setCategoryDialogOpen(false)
                  setEditingCategory(null)
                }}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCategorySave} noValidate className="p-6 space-y-4">
              {categoryFormError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border bg-error/10 border-error/20 text-error">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span className="text-xs font-bold">{categoryFormError}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">
                  ชื่อประเภทข่าว *
                </label>
                <input
                  type="text"
                  value={categoryForm.name}
                  onChange={(e) => {
                    setCategoryForm({ ...categoryForm, name: e.target.value })
                    clearCategoryFieldError("name")
                  }}
                  maxLength={NAME_MAX}
                  placeholder="เช่น ประกาศทั่วไป"
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-bold"
                />
                <FieldError message={categoryFieldErrors.name} />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">ลำดับ</label>
                <input
                  type="number"
                  min={0}
                  max={SORT_ORDER_MAX}
                  value={categoryForm.sort_order}
                  onChange={(e) => {
                    setCategoryForm({ ...categoryForm, sort_order: e.target.value })
                    clearCategoryFieldError("sort_order")
                  }}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                />
                <p className="text-[11px] text-base-content/50 ml-1">เลขน้อยจะแสดงก่อน</p>
                <FieldError message={categoryFieldErrors.sort_order} />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={categoryForm.is_active}
                  onChange={(e) => setCategoryForm({ ...categoryForm, is_active: e.target.checked })}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <span className="text-sm font-bold text-base-content/70">ใช้งาน</span>
              </label>

              {categoryInUse && !categoryForm.is_active && (
                <p className="text-[11px] font-bold text-warning ml-1">
                  มีข่าว {editingCategory?.news_count} รายการใช้ประเภทนี้อยู่ — ข่าวเหล่านั้นยังใช้ต่อและยังแสดงอยู่
                  แต่จะเลือกประเภทนี้ให้ข่าวใหม่ไม่ได้
                </p>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setCategoryDialogOpen(false)
                    setEditingCategory(null)
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={categorySaving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {categorySaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {editingCategory ? "บันทึกการแก้ไข" : "เพิ่มประเภท"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
