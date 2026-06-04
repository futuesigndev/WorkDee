"use client"

import React, { useState, useEffect, useMemo } from "react"
import {
  Layers, Plus, Trash2, X, Loader2, CheckCircle2, AlertCircle,
  ChevronUp, ChevronDown, Search, Edit2, ToggleLeft, ToggleRight,
  Save, FolderTree, ChevronRight
} from "lucide-react"
import { cn } from "@/lib/utils"
import { API_URL } from "@/lib/api"

// ── Available icons for selector ──────────────────────────────────────────────
const AVAILABLE_ICONS = [
  "LayoutDashboard", "Users", "ShieldCheck", "MessageSquare", "History",
  "Settings", "Bell", "Globe", "FileText", "Database", "Palette",
  "Link2", "Layers", "BarChart2", "Lock", "Home", "Circle"
]

interface Menu {
  id: string
  key: string
  label: string
  path: string
  icon: string | null
  parent_id: string | null
  order: number
  is_active: boolean
}

type SortKey = "label" | "key" | "order"

export default function MenuManagementPage() {
  const [menus, setMenus] = useState<Menu[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState({ type: "", text: "" })

  // ── Table controls ───────────────────────────────────────────────────────
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("order")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  // ── Create modal ─────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    key: "", label: "", path: "", icon: "Circle", parent_id: "", order: "0"
  })

  // ── Edit modal ───────────────────────────────────────────────────────────
  const [editMenu, setEditMenu] = useState<Menu | null>(null)
  const [editForm, setEditForm] = useState({
    label: "", path: "", icon: "", order: "0"
  })
  const [saving, setSaving] = useState(false)

  // ── Delete modal ─────────────────────────────────────────────────────────
  const [menuToDelete, setMenuToDelete] = useState<Menu | null>(null)
  const [deleting, setDeleting] = useState(false)

  // ── Collapse parent menu states ───────────────────────────────────────────
  const [collapsedParentIds, setCollapsedParentIds] = useState<string[]>([])
  const toggleParentCollapse = (id: string) => {
    setCollapsedParentIds(prev =>
      prev.includes(id) ? prev.filter(pId => pId !== id) : [...prev, id]
    )
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  const fetchMenus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/menus`, { credentials: "include" })
      if (res.ok) setMenus(await res.json())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchMenus() }, [])

  const showMsg = (type: string, text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage({ type: "", text: "" }), 3500)
  }

  // ── Computed: sorted & filtered flat list ─────────────────────────────────
  const parentMenus = useMemo(() => menus.filter(m => !m.parent_id), [menus])

  const displayed = useMemo(() => {
    const q = search.toLowerCase()
    // Build hierarchy: parents first, then their children
    const result: (Menu & { isChild: boolean })[] = []
    for (const parent of parentMenus) {
      const isParentVisible = !q || parent.label.toLowerCase().includes(q) || parent.key.toLowerCase().includes(q)
      if (isParentVisible) {
        result.push({ ...parent, isChild: false })
      }
      
      const isCollapsed = collapsedParentIds.includes(parent.id)
      if (!isCollapsed || q) {
        const children = menus
          .filter(m => m.parent_id === parent.id)
          .filter(m => !q || m.label.toLowerCase().includes(q) || m.key.toLowerCase().includes(q))
          .sort((a, b) => a.order - b.order)
        for (const child of children) {
          result.push({ ...child, isChild: true })
        }
      }
    }
    // Orphan children (parent not visible) shown at bottom
    menus
      .filter(m => m.parent_id && !parentMenus.find(p => p.id === m.parent_id))
      .forEach(m => {
        if (!q || m.label.toLowerCase().includes(q)) result.push({ ...m, isChild: true })
      })
    return result
  }, [menus, parentMenus, search, collapsedParentIds])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc")
    else { setSortKey(key); setSortDir("asc") }
  }

  const SortIcon = ({ col }: { col: SortKey }) =>
    sortKey === col
      ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
      : <ChevronUp size={12} className="opacity-20" />

  // ── Create ────────────────────────────────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.key.trim() || !form.label.trim() || !form.path.trim()) return
    setCreating(true)
    try {
      const body: any = {
        key: form.key.trim(),
        label: form.label.trim(),
        path: form.path.trim(),
        icon: form.icon,
        order: parseInt(form.order) || 0
      }
      if (form.parent_id) body.parent_id = form.parent_id
      const res = await fetch(`${API_URL}/api/v1/menus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
      })
      if (res.ok) {
        showMsg("success", "Menu created successfully!")
        setShowCreate(false)
        setForm({ key: "", label: "", path: "", icon: "Circle", parent_id: "", order: "0" })
        fetchMenus()
      } else {
        const err = await res.json()
        showMsg("error", err.detail || "Failed to create menu")
      }
    } catch { showMsg("error", "Network error") }
    finally { setCreating(false) }
  }

  // ── Edit ──────────────────────────────────────────────────────────────────
  const openEdit = (menu: Menu) => {
    setEditMenu(menu)
    setEditForm({ label: menu.label, path: menu.path, icon: menu.icon || "Circle", order: String(menu.order) })
  }

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editMenu) return
    setSaving(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/menus/${editMenu.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          label: editForm.label,
          path: editForm.path,
          icon: editForm.icon,
          order: parseInt(editForm.order) || 0
        })
      })
      if (res.ok) {
        showMsg("success", "Menu updated!")
        setEditMenu(null)
        fetchMenus()
      } else {
        showMsg("error", "Failed to update menu")
      }
    } catch { showMsg("error", "Network error") }
    finally { setSaving(false) }
  }

  // ── Toggle active ─────────────────────────────────────────────────────────
  const toggleActive = async (menu: Menu) => {
    try {
      await fetch(`${API_URL}/api/v1/menus/${menu.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ is_active: !menu.is_active })
      })
      fetchMenus()
    } catch { showMsg("error", "Failed to toggle menu") }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!menuToDelete) return
    setDeleting(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/menus/${menuToDelete.id}`, {
        method: "DELETE",
        credentials: "include"
      })
      if (res.ok) {
        showMsg("success", `"${menuToDelete.label}" deleted`)
        setMenuToDelete(null)
        fetchMenus()
      } else {
        showMsg("error", "Failed to delete menu")
      }
    } catch { showMsg("error", "Network error") }
    finally { setDeleting(false) }
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-[400px]">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  )

  return (
    <div className="space-y-6 max-w-6xl pb-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">Menu Management</h1>
          <p className="text-base-content/50 font-bold text-[10px] uppercase tracking-widest">
            Navigation Structure & Hierarchy
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95"
        >
          <Plus size={16} />
          Add Menu
        </button>
      </div>

      {/* Message */}
      {message.text && (
        <div className={cn(
          "flex items-center gap-3 px-5 py-4 rounded-xl border animate-in fade-in slide-in-from-top-4 duration-300",
          message.type === "success" ? "bg-success/10 border-success/20 text-success" : "bg-error/10 border-error/20 text-error"
        )}>
          {message.type === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
          <span className="text-sm font-bold">{message.text}</span>
        </div>
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Menus", value: menus.length },
          { label: "Parent Menus", value: menus.filter(m => !m.parent_id).length },
          { label: "Active", value: menus.filter(m => m.is_active).length },
        ].map(stat => (
          <div key={stat.label} className="bg-base-100 rounded-2xl border border-base-300 p-4 text-center shadow-sm">
            <div className="text-2xl font-black text-primary">{stat.value}</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-base-content/40 mt-0.5">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Table card */}
      <div className="bg-base-100 rounded-2xl border border-base-300 shadow-sm overflow-hidden">
        {/* Search bar */}
        <div className="px-6 py-4 border-b border-base-300 flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" />
            <input
              type="text"
              placeholder="Search menus..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-4 py-2 text-sm bg-base-200/60 border-none rounded-xl outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-base-content/40 font-bold">
            <FolderTree size={14} />
            {displayed.length} items
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-base-200/60 border-b border-base-300">
                <th className="px-6 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 w-10">#</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40">Icon</th>
                <th
                  className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 cursor-pointer hover:text-base-content transition-colors"
                  onClick={() => handleSort("label")}
                >
                  <div className="flex items-center gap-1.5">Label <SortIcon col="label" /></div>
                </th>
                <th
                  className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 cursor-pointer hover:text-base-content transition-colors hidden md:table-cell"
                  onClick={() => handleSort("key")}
                >
                  <div className="flex items-center gap-1.5">Key <SortIcon col="key" /></div>
                </th>
                <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 hidden lg:table-cell">Path</th>
                <th
                  className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 cursor-pointer hover:text-base-content transition-colors w-20"
                  onClick={() => handleSort("order")}
                >
                  <div className="flex items-center gap-1.5">Order <SortIcon col="order" /></div>
                </th>
                <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 w-24">Status</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-base-content/40 w-24 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-300/50">
              {displayed.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-base-content/30 font-bold">
                    No menus found
                  </td>
                </tr>
              ) : displayed.map((menu, idx) => {
                const parentName = menu.parent_id
                  ? menus.find(m => m.id === menu.parent_id)?.label
                  : null
                return (
                  <tr
                    key={menu.id}
                    className={cn(
                      "hover:bg-base-200/40 transition-colors",
                      menu.isChild && "bg-base-200/20",
                      !menu.is_active && "opacity-50"
                    )}
                  >
                    <td className="px-6 py-3.5 text-xs font-bold text-base-content/30">{idx + 1}</td>
                    <td className="px-4 py-3.5">
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black",
                        menu.isChild
                          ? "bg-base-200 text-base-content/50 ml-4"
                          : "bg-primary/10 text-primary"
                      )}>
                        {menu.icon?.charAt(0) || "?"}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col">
                        <div className={cn(
                          "font-black text-sm flex items-center gap-1",
                          menu.isChild && "pl-4 border-l-2 border-primary/20"
                        )}>
                          {menu.isChild ? (
                            <span className="text-primary/40 mr-1.5 font-mono">└</span>
                          ) : (
                            menus.some(m => m.parent_id === menu.id) && (
                              <button
                                onClick={() => toggleParentCollapse(menu.id)}
                                className="p-1 hover:bg-base-200 rounded-md transition-colors text-base-content/40 hover:text-base-content mr-1"
                              >
                                {collapsedParentIds.includes(menu.id) ? (
                                  <ChevronRight size={12} />
                                ) : (
                                  <ChevronDown size={12} />
                                )}
                              </button>
                            )
                          )}
                          {menu.label}
                        </div>
                        {parentName && (
                          <div className="text-[10px] text-base-content/30 font-medium mt-0.5 pl-4">
                            under {parentName}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <span className="font-mono text-xs bg-base-200 px-2 py-1 rounded-lg text-base-content/60">
                        {menu.key}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 hidden lg:table-cell">
                      <span className="text-xs text-base-content/50 font-mono">{menu.path}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="text-sm font-black text-base-content/60">{menu.order}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <button
                        onClick={() => toggleActive(menu)}
                        className={cn(
                          "flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full transition-all",
                          menu.is_active
                            ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                            : "bg-base-300 text-base-content/40 hover:bg-base-200"
                        )}
                      >
                        {menu.is_active ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
                        {menu.is_active ? "Active" : "Off"}
                      </button>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => openEdit(menu)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-primary/10 text-base-content/40 hover:text-primary transition-all"
                          title="Edit"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          onClick={() => setMenuToDelete(menu)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-error/10 text-base-content/40 hover:text-error transition-all"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Create Modal ─────────────────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-base-100 rounded-2xl shadow-2xl w-full max-w-lg border border-base-300 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Plus size={16} className="text-primary" />
                </div>
                <h2 className="font-black text-base">Add Menu</h2>
              </div>
              <button onClick={() => setShowCreate(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-base-200 transition-colors">
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Label *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Reports"
                    value={form.label}
                    onChange={e => setForm({ ...form, label: e.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Key * (unique)</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. reports"
                    value={form.key}
                    onChange={e => setForm({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Path *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. /dashboard/reports"
                  value={form.path}
                  onChange={e => setForm({ ...form, path: e.target.value })}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Icon</label>
                  <select
                    value={form.icon}
                    onChange={e => setForm({ ...form, icon: e.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                  >
                    {AVAILABLE_ICONS.map(ic => (
                      <option key={ic} value={ic}>{ic}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Order</label>
                  <input
                    type="number"
                    min="0"
                    value={form.order}
                    onChange={e => setForm({ ...form, order: e.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Parent Menu (optional — leave blank for top-level)</label>
                <select
                  value={form.parent_id}
                  onChange={e => setForm({ ...form, parent_id: e.target.value })}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                >
                  <option value="">— Top-level menu —</option>
                  {parentMenus.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50"
                >
                  {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Create Menu
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit Modal ───────────────────────────────────────────────────────── */}
      {editMenu && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-base-100 rounded-2xl shadow-2xl w-full max-w-md border border-base-300 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Edit2 size={15} className="text-primary" />
                </div>
                <div>
                  <h2 className="font-black text-sm">Edit Menu</h2>
                  <p className="text-[10px] text-base-content/40 font-mono">{editMenu.key}</p>
                </div>
              </div>
              <button onClick={() => setEditMenu(null)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-base-200 transition-colors">
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleEdit} className="p-6 space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Label</label>
                <input
                  type="text"
                  value={editForm.label}
                  onChange={e => setEditForm({ ...editForm, label: e.target.value })}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Path</label>
                <input
                  type="text"
                  value={editForm.path}
                  onChange={e => setEditForm({ ...editForm, path: e.target.value })}
                  className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-mono text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Icon</label>
                  <select
                    value={editForm.icon}
                    onChange={e => setEditForm({ ...editForm, icon: e.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                  >
                    {AVAILABLE_ICONS.map(ic => (
                      <option key={ic} value={ic}>{ic}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-base-content/40">Order</label>
                  <input
                    type="number"
                    min="0"
                    value={editForm.order}
                    onChange={e => setEditForm({ ...editForm, order: e.target.value })}
                    className="w-full bg-base-200/60 border-none rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditMenu(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl text-sm font-black hover:opacity-90 transition-all disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirm Modal ─────────────────────────────────────────────── */}
      {menuToDelete && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-base-100 rounded-2xl shadow-2xl w-full max-w-sm border border-base-300 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-error/10 flex items-center justify-center mx-auto">
                <Trash2 size={24} className="text-error" />
              </div>
              <div>
                <h3 className="font-black text-base mb-1">Delete Menu?</h3>
                <p className="text-sm text-base-content/60">
                  Delete <strong>"{menuToDelete.label}"</strong>?
                  {!menuToDelete.parent_id && (
                    <span className="block mt-1 text-error/80 text-xs font-bold">
                      ⚠ This will also delete all child menus!
                    </span>
                  )}
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setMenuToDelete(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-base-300 text-sm font-black hover:bg-base-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-error text-white rounded-xl text-sm font-black hover:bg-error/90 transition-all disabled:opacity-50"
                >
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
