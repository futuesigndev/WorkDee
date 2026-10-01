"use client"

import React, { useState, useEffect } from "react"
import { 
  ShieldCheck, 
  Save,
  Loader2,
  ChevronRight,
  Menu as MenuIcon,
  AlertCircle,
  Lock,
  Plus,
  Trash2,
  Pencil,
  X,
  Search,
  ChevronUp,
  ChevronDown
} from "lucide-react"
import { cn } from "@/lib/utils"
import { API_URL, apiFetch } from "@/lib/api"
import { isPermissionDenied, permissionErrorMessage } from "@/lib/errors"
import AccessDenied from "@/components/AccessDenied"

interface Role {
  id: string;
  name: string;
  display_name?: string;
  description?: string;
  is_system_role: boolean;
}

interface Menu {
  id: string;
  key: string;
  label: string;
  path: string;
  parent_id?: string;
  order: number;
}

export default function RolesPermissionsPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [menus, setMenus] = useState<Menu[]>([])
  const [selectedRole, setSelectedRole] = useState<Role | null>(null)
  const [allowedMenuIds, setAllowedMenuIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [collapsedParentIds, setCollapsedParentIds] = useState<string[]>([])

  // CRUD & Search/Sort states
  const [searchRole, setSearchRole] = useState("")
  const [roleSortOrder, setRoleSortOrder] = useState<'asc' | 'desc'>('asc')
  
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newRoleName, setNewRoleName] = useState("")
  const [newRoleDesc, setNewRoleDesc] = useState("")
  const [creating, setCreating] = useState(false)
  
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null)
  const [deletingRole, setDeletingRole] = useState(false)

  // Task 047/D13: the edit control the API has always allowed (`PATCH /roles/{id}`) but no screen
  // offered. `notice` is the page-level result banner; `editMessage` is the modal's own line, used
  // for the Thai validation (empty name) and for the server's `detail` (duplicate name, 404).
  const [notice, setNotice] = useState({ type: "", text: "" })
  const [roleToEdit, setRoleToEdit] = useState<Role | null>(null)
  const [editRoleName, setEditRoleName] = useState("")
  const [editRoleDesc, setEditRoleDesc] = useState("")
  const [editMessage, setEditMessage] = useState<{ type: "error" | "info"; text: string } | null>(null)
  const [savingRoleEdit, setSavingRoleEdit] = useState(false)

  const toggleParentCollapse = (id: string) => {
    setCollapsedParentIds(prev => 
      prev.includes(id) ? prev.filter(pId => pId !== id) : [...prev, id]
    )
  }

  // Compute hierarchical sorted list of menus
  const hierarchicalMenus = React.useMemo(() => {
    const parents = menus.filter(m => !m.parent_id).sort((a, b) => a.order - b.order)
    const children = menus.filter(m => m.parent_id)

    const result: (Menu & { isChild: boolean })[] = []
    parents.forEach(parent => {
      result.push({ ...parent, isChild: false })
      const parentChildren = children
        .filter(c => c.parent_id === parent.id)
        .sort((a, b) => a.order - b.order)
      parentChildren.forEach(child => {
        result.push({ ...child, isChild: true })
      })
    })

    // Orphaned children if any
    const addedIds = new Set(result.map(r => r.id))
    menus.forEach(m => {
      if (!addedIds.has(m.id)) {
        result.push({ ...m, isChild: !!m.parent_id })
      }
    })

    return result
  }, [menus])

  // Filter visible menus based on collapsed state
  const visibleMenus = React.useMemo(() => {
    return hierarchicalMenus.filter(menu => {
      if (menu.parent_id) {
        return !collapsedParentIds.includes(menu.parent_id)
      }
      return true
    })
  }, [hierarchicalMenus, collapsedParentIds])

  const fetchData = async () => {
    try {
      const [rRes, mRes] = await Promise.all([
        apiFetch(`${API_URL}/api/v1/roles`),
        apiFetch(`${API_URL}/api/v1/roles/menus`)
      ])
      
      if (rRes.ok && mRes.ok) {
        const rData = await rRes.json()
        const mData = await mRes.json()
        setRoles(rData)
        setMenus(mData)
        if (rData.length > 0) setSelectedRole(rData[0])
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error("Failed to fetch roles/menus", err)
    } finally {
      setLoading(false)
    }
  }

  const fetchPermissions = async (roleId: string) => {
    try {
      const res = await apiFetch(`${API_URL}/api/v1/roles/${roleId}/permissions`)
      if (res.ok) {
        const data = await res.json()
        setAllowedMenuIds(data.menu_ids || [])
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error("Failed to fetch permissions", err)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load on mount into state, which is what this effect is for (032)
    fetchData()
  }, [])

  useEffect(() => {
    if (selectedRole) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- loading the selected role's permissions into state is the purpose of this effect (032)
      fetchPermissions(selectedRole.id)
    }
  }, [selectedRole])

  const togglePermission = (menuId: string) => {
    const isChecked = allowedMenuIds.includes(menuId)
    const menu = menus.find(m => m.id === menuId)
    
    if (menu && !menu.parent_id) {
      // Toggle parent AND all its child menus
      const childIds = menus.filter(m => m.parent_id === menu.id).map(m => m.id)
      
      if (isChecked) {
        // Uncheck parent and all children
        setAllowedMenuIds(prev => prev.filter(id => id !== menuId && !childIds.includes(id)))
      } else {
        // Check parent and all children
        setAllowedMenuIds(prev => [...new Set([...prev, menuId, ...childIds])])
      }
    } else {
      // Toggle a child menu. The server requires the parent group to be granted with it (task 045/D6),
      // so ticking a child ticks its parent too — deliberately *without* the parent's own child-cascade,
      // otherwise one child would drag in its siblings. Unticking a child leaves the parent alone.
      const parentId = menu?.parent_id
      setAllowedMenuIds(prev => {
        if (prev.includes(menuId)) return prev.filter(id => id !== menuId)
        const next = new Set(prev)
        next.add(menuId)
        if (parentId) next.add(parentId)
        return [...next]
      })
    }
  }

  const handleSave = async () => {
    if (!selectedRole) return
    setSaving(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/roles/${selectedRole.id}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menu_ids: allowedMenuIds }),
      })
      if (res.ok) {
        alert("บันทึกสิทธิ์แล้ว")
      } else {
        // The server refuses a grant whose child would have no visible group (task 045/D6) — its Thai
        // message names the parent menu, so it has to be shown rather than swallowed.
        const error = await res.json().catch(() => null)
        alert(error?.detail || "บันทึกสิทธิ์ไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "บันทึกสิทธิ์ไม่สำเร็จ"))
    } finally {
      setSaving(false)
    }
  }

  const handleCreateRole = async () => {
    if (!newRoleName.trim()) return
    setCreating(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoleName, description: newRoleDesc }),
      })
      if (res.ok) {
        setShowCreateModal(false)
        setNewRoleName("")
        setNewRoleDesc("")
        fetchData()
      } else {
        const error = await res.json()
        alert(error.detail || "สร้างบทบาทไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"))
    } finally {
      setCreating(false)
    }
  }

  const openEditRole = (role: Role) => {
    setEditRoleName(role.name)
    setEditRoleDesc(role.description ?? "")
    setEditMessage(null)
    setRoleToEdit(role)
  }

  /**
   * Saves a role's name/description through the existing `PATCH /roles/{id}` (task 047/D13).
   *
   * The API decides what is allowed (a system role keeps its name; the page disables that field
   * instead of guessing), and its `detail` is shown as written for the duplicate-name and 404 cases.
   * A change that changes nothing is not sent at all: the API would leave it untraced, so the admin
   * is told "ไม่มีการเปลี่ยนแปลง" instead of seeing a save that reported success but wrote no record.
   */
  const handleSaveRoleEdit = async () => {
    if (!roleToEdit) return
    const name = editRoleName.trim()
    if (!name) {
      setEditMessage({ type: "error", text: "กรุณากรอกชื่อบทบาท" })
      return
    }
    const description = editRoleDesc.trim()
    if (name === roleToEdit.name && description === (roleToEdit.description ?? "")) {
      setEditMessage({ type: "info", text: "ไม่มีการเปลี่ยนแปลง" })
      return
    }
    setSavingRoleEdit(true)
    setEditMessage(null)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/roles/${roleToEdit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // An empty description is sent as `""` (never omitted): the API reads `null` as "leave it
        // alone", so only an explicit empty string can clear one.
        body: JSON.stringify({ name, description }),
      })
      if (res.ok) {
        const updated: Role = await res.json()
        setRoles(prev => prev.map(r => (r.id === updated.id ? { ...r, ...updated } : r)))
        setSelectedRole(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev))
        setRoleToEdit(null)
        setNotice({ type: "success", text: "บันทึกบทบาทแล้ว" })
        setTimeout(() => setNotice({ type: "", text: "" }), 3000)
      } else {
        const error = await res.json().catch(() => null)
        setEditMessage({ type: "error", text: error?.detail || "บันทึกบทบาทไม่สำเร็จ" })
      }
    } catch (err) {
      setEditMessage({ type: "error", text: permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้") })
    } finally {
      setSavingRoleEdit(false)
    }
  }

  const handleDeleteRole = async (roleId: string) => {
    setDeletingRole(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/roles/${roleId}`, {
        method: "DELETE",
      })
      if (res.ok) {
        setRoleToDelete(null)
        const updatedRoles = roles.filter(r => r.id !== roleId)
        setRoles(updatedRoles)
        if (selectedRole?.id === roleId) {
          setSelectedRole(updatedRoles.length > 0 ? updatedRoles[0] : null)
        }
        fetchData()
      } else {
        // Parsed defensively: a 500 answers with a plain-text body, and `res.json()` throwing there used
        // to send the admin to the catch below — "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้" for a server-side error
        // (task 045/D5). A refusal with a JSON `detail` (e.g. the role is in use) is shown as written.
        const error = await res.json().catch(() => null)
        alert(error?.detail || "ลบบทบาทไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"))
    } finally {
      setDeletingRole(false)
    }
  }

  const processedRoles = React.useMemo(() => {
    const result = roles.filter(r => 
      r.name.toLowerCase().includes(searchRole.toLowerCase()) ||
      (r.description && r.description.toLowerCase().includes(searchRole.toLowerCase()))
    )
    result.sort((a, b) => {
      return roleSortOrder === 'asc' 
        ? a.name.localeCompare(b.name)
        : b.name.localeCompare(a.name)
    })
    return result
  }, [roles, searchRole, roleSortOrder])

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  )

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2 text-base-content">
            <ShieldCheck className="text-primary" /> บทบาทและสิทธิ์
          </h1>
          <p className="text-base-content/50 text-sm font-bold">กำหนดว่าแต่ละบทบาทเห็นและทำอะไรได้</p>
        </div>
        <button 
          onClick={handleSave}
          disabled={saving || !selectedRole}
          className="bg-primary text-primary-content flex items-center gap-2 h-10 px-6 font-bold shadow-lg shadow-primary/20 rounded-xl cursor-pointer hover:opacity-90 active:scale-95 transition-all text-xs"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          บันทึก
        </button>
      </div>

      {notice.text && (
        <div className={cn(
          "px-4 py-3 rounded-2xl border text-xs font-bold",
          notice.type === "success"
            ? "bg-success/10 border-success/30 text-success"
            : "bg-error/10 border-error/30 text-error"
        )}>
          {notice.text}
        </div>
      )}

      <div className="flex h-[calc(100vh-200px)] bg-base-100 rounded-2xl border border-base-200 overflow-hidden shadow-sm">
        <div className="w-80 border-r border-base-200 flex flex-col bg-base-200/20">
          <div className="p-4 border-b border-base-200 bg-base-100/50 flex items-center justify-between gap-2">
            <h2 className="text-xs font-black text-base-content/40">บทบาท</h2>
            <button
              onClick={() => {
                setNewRoleName("")
                setNewRoleDesc("")
                setShowCreateModal(true)
              }}
              className="px-2.5 py-1 bg-primary text-primary-content rounded-lg text-[10px] font-black hover:opacity-90 active:scale-95 transition-all flex items-center gap-1 cursor-pointer"
              title="เพิ่มบทบาทใหม่"
            >
              <Plus size={10} /> เพิ่ม
            </button>
          </div>
          
          {/* Sidebar Search & Sort Controls */}
          <div className="p-3 border-b border-base-200 flex items-center gap-2 bg-base-100/30">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/30" size={13} />
              <input
                type="text"
                placeholder="ค้นหาบทบาท..."
                value={searchRole}
                onChange={(e) => setSearchRole(e.target.value)}
                className="w-full bg-base-200 border-none rounded-lg pl-8 pr-2 py-1 text-xs focus:ring-1 focus:ring-primary outline-none"
              />
            </div>
            <button
              onClick={() => setRoleSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
              className="p-1.5 hover:bg-base-200 rounded-lg text-base-content/50 transition-colors cursor-pointer flex items-center justify-center"
              title={roleSortOrder === 'asc' ? 'เรียงจากมากไปน้อย' : 'เรียงจากน้อยไปมาก'}
            >
              {roleSortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-base-100">
            {processedRoles.map(role => (
              <div 
                key={role.id}
                className={cn(
                  "w-full rounded-xl transition-all flex items-center justify-between group",
                  selectedRole?.id === role.id 
                    ? "bg-primary text-primary-content shadow-md" 
                    : "hover:bg-base-200/50 text-base-content/70"
                )}
              >
                <button
                  onClick={() => setSelectedRole(role)}
                  aria-label={`เลือกบทบาท ${role.name} เพื่อกำหนดสิทธิ์เมนู`}
                  className="flex-1 text-left p-3.5 pr-1 text-xs font-bold truncate cursor-pointer"
                >
                  <div className="truncate">{role.name}</div>
                  <div className={cn(
                    "text-[9px] mt-0.5 font-normal",
                    selectedRole?.id === role.id ? "text-primary-content/60" : "text-base-content/40"
                  )}>
                    {role.is_system_role ? "บทบาทของระบบ" : "บทบาทที่สร้างเอง"}
                  </div>
                </button>
                
                <div className="flex items-center gap-0.5 pr-2.5 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openEditRole(role)
                    }}
                    title="แก้ไขชื่อและคำอธิบาย"
                    aria-label={`แก้ไขบทบาท ${role.name}`}
                    className={cn(
                      "p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all cursor-pointer flex items-center justify-center",
                      selectedRole?.id === role.id 
                        ? "text-primary-content/60 hover:text-white hover:bg-white/10" 
                        : "text-base-content/30 hover:text-primary"
                    )}
                  >
                    <Pencil size={13} />
                  </button>
                  {!role.is_system_role && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setRoleToDelete(role)
                      }}
                      aria-label={`ลบบทบาท ${role.name}`}
                      className={cn(
                        "p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-red-500/10 cursor-pointer flex items-center justify-center",
                        selectedRole?.id === role.id 
                          ? "text-primary-content/60 hover:text-white hover:bg-white/10" 
                          : "text-base-content/30 hover:text-red-500"
                      )}
                      title="ลบบทบาทที่สร้างเอง"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <ChevronRight className={cn(
                    "w-3.5 h-3.5 transition-transform",
                    selectedRole?.id === role.id ? "translate-x-0.5" : "opacity-0 group-hover:opacity-100"
                  )} />
                </div>
              </div>
            ))}
            
            {processedRoles.length === 0 && (
              <div className="text-center py-6 text-xs text-base-content/30 italic">ไม่พบบทบาท</div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col bg-base-100">
          {selectedRole ? (
            <>
              <div className="p-6 border-b border-base-200 bg-base-100/50">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <ShieldCheck className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black uppercase tracking-wider">{selectedRole.display_name || selectedRole.name}</h3>
                    <p className="text-xs text-base-content/50">{selectedRole.description || "กำหนดระดับการเข้าถึงเมนูของบทบาทนี้"}</p>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-4xl mx-auto space-y-6">
                  <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-primary mt-0.5" />
                    <p className="text-xs text-primary/80 leading-relaxed font-medium">
                      เลือกเมนูที่บทบาทนี้เข้าใช้งานได้
                    </p>
                  </div>

                  <div className="divide-y divide-base-200 border border-base-200 rounded-2xl overflow-hidden shadow-sm">
                    {visibleMenus.map(menu => {
                      const isParent = !menu.parent_id
                      const isCollapsed = collapsedParentIds.includes(menu.id)
                      const childrenCount = menus.filter(m => m.parent_id === menu.id).length

                      return (
                        <div 
                          key={menu.id} 
                          className={cn(
                            "flex items-center justify-between p-5 hover:bg-base-200/50 transition-colors bg-base-100",
                            menu.parent_id && "pl-16 bg-base-200/10"
                          )}
                        >
                          <div className="flex items-center gap-4">
                            {isParent && childrenCount > 0 ? (
                              <button
                                onClick={() => toggleParentCollapse(menu.id)}
                                aria-label={isCollapsed ? `ขยายเมนูย่อยของ ${menu.label}` : `ย่อเมนูย่อยของ ${menu.label}`}
                                className="p-1 hover:bg-base-200 rounded-md transition-colors text-base-content/40 hover:text-base-content mr-1"
                              >
                                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                              </button>
                            ) : !isParent ? (
                              <span className="text-primary/40 mr-1.5 font-mono text-sm ml-7 select-none">└</span>
                            ) : (
                              <div className="w-7" />
                            )}

                            <div className={cn(
                              "w-10 h-10 rounded-xl bg-base-200 flex items-center justify-center",
                              menu.parent_id ? "w-8 h-8" : ""
                            )}>
                              <MenuIcon className={cn("text-base-content/40", menu.parent_id ? "w-4 h-4" : "w-5 h-5")} />
                            </div>
                            <div>
                              <div className={cn("text-sm font-bold text-base-content", isParent ? "font-black text-primary" : "")}>
                                {menu.label}
                                {isParent && childrenCount > 0 && (
                                  <span className="text-[10px] text-base-content/30 ml-2 font-normal">
                                    (เมนูย่อย {childrenCount})
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono text-base-content/30 lowercase">{menu.path}</div>
                            </div>
                          </div>
                          
                          <label className="relative inline-flex items-center cursor-pointer group">
                            <input 
                              type="checkbox" 
                              className="sr-only peer"
                              aria-label={`เปิดใช้เมนู ${menu.label} ให้บทบาท ${selectedRole ? selectedRole.name : ""}`}
                              checked={allowedMenuIds.includes(menu.id)}
                              onChange={() => togglePermission(menu.id)}
                            />
                            <div className={cn(
                              "w-12 h-6 bg-base-300 rounded-full transition-all",
                              "peer-checked:bg-primary peer-checked:after:translate-x-6",
                              "after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all shadow-inner",
                              "group-hover:ring-4 group-hover:ring-primary/10"
                            )}></div>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-base-content/30 space-y-4">
              <Lock className="w-16 h-16 opacity-10" />
              <div className="text-center">
                <p className="text-sm font-black text-base-content/20">การเข้าถึงเมนู</p>
                <p className="text-xs">เลือกบทบาทเพื่อเริ่มกำหนดสิทธิ์</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Role Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="p-5 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-base font-black tracking-tight text-base-content flex items-center gap-2">
                  <ShieldCheck className="text-primary" size={18} /> สร้างบทบาทใหม่
                </h2>
                <p className="text-[11px] text-base-content/50 mt-0.5">กำหนดบทบาทใหม่สำหรับควบคุมการเข้าถึงเมนู</p>
              </div>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="p-1.5 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer flex items-center justify-center"
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-base-content/40">ชื่อบทบาท</label>
                <input 
                  type="text" 
                  placeholder="เช่น Operator, Coordinator..." 
                  value={newRoleName}
                  onChange={(e) => setNewRoleName(e.target.value)}
                  className="w-full bg-base-200 border-none rounded-xl px-3.5 py-2 text-xs focus:ring-1 focus:ring-primary outline-none font-bold"
                />
              </div>
              
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-base-content/40">รายละเอียด</label>
                <textarea 
                  placeholder="อธิบายหน้าที่หรือการเข้าถึงเมนูของบทบาทนี้" 
                  value={newRoleDesc}
                  onChange={(e) => setNewRoleDesc(e.target.value)}
                  rows={3}
                  className="w-full bg-base-200 border-none rounded-xl px-3.5 py-2 text-xs focus:ring-1 focus:ring-primary outline-none"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-base-300 flex justify-end gap-2 bg-base-200/50">
              <button 
                onClick={() => setShowCreateModal(false)}
                className="px-3.5 py-2 hover:bg-base-300 rounded-xl text-xs font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={handleCreateRole}
                disabled={creating || !newRoleName.trim()}
                className="bg-primary text-primary-content rounded-xl px-5 py-2 text-xs font-bold shadow-lg shadow-primary/10 flex items-center gap-1.5 cursor-pointer hover:opacity-90 active:scale-98 transition-all disabled:opacity-50"
              >
                {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                สร้างบทบาท
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Role Modal (task 047/D13) */}
      {roleToEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="p-5 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-base font-black tracking-tight text-base-content flex items-center gap-2">
                  <Pencil className="text-primary" size={16} /> แก้ไขบทบาท
                </h2>
                <p className="text-[11px] text-base-content/50 mt-0.5">แก้ชื่อและคำอธิบายของบทบาทนี้</p>
              </div>
              <button
                onClick={() => setRoleToEdit(null)}
                aria-label="ปิดหน้าต่างแก้ไขบทบาท"
                className="p-1.5 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer flex items-center justify-center"
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-base-content/40">ชื่อบทบาท</label>
                <input
                  type="text"
                  aria-label="ชื่อบทบาท"
                  value={editRoleName}
                  disabled={roleToEdit.is_system_role}
                  onChange={(e) => {
                    setEditRoleName(e.target.value)
                    setEditMessage(null)
                  }}
                  className="w-full bg-base-200 border-none rounded-xl px-3.5 py-2 text-xs focus:ring-1 focus:ring-primary outline-none font-bold disabled:opacity-60 disabled:cursor-not-allowed"
                />
                {roleToEdit.is_system_role && (
                  <p className="text-[10px] font-bold text-base-content/40">
                    บทบาทของระบบเปลี่ยนชื่อไม่ได้ แต่แก้คำอธิบายได้
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-base-content/40">รายละเอียด</label>
                <textarea
                  rows={3}
                  aria-label="รายละเอียดบทบาท"
                  value={editRoleDesc}
                  onChange={(e) => {
                    setEditRoleDesc(e.target.value)
                    setEditMessage(null)
                  }}
                  placeholder="อธิบายหน้าที่หรือการเข้าถึงเมนูของบทบาทนี้"
                  className="w-full bg-base-200 border-none rounded-xl px-3.5 py-2 text-xs focus:ring-1 focus:ring-primary outline-none"
                />
              </div>

              {editMessage && (
                <p className={cn(
                  "text-[11px] font-bold px-3 py-2 rounded-xl border",
                  editMessage.type === "error"
                    ? "bg-error/10 border-error/30 text-error"
                    : "bg-base-200 border-base-300 text-base-content/60"
                )}>
                  {editMessage.text}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-base-300 flex justify-end gap-2 bg-base-200/50">
              <button
                onClick={() => setRoleToEdit(null)}
                className="px-3.5 py-2 hover:bg-base-300 rounded-xl text-xs font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleSaveRoleEdit}
                disabled={savingRoleEdit}
                className="bg-primary text-primary-content rounded-xl px-5 py-2 text-xs font-bold shadow-lg shadow-primary/10 flex items-center gap-1.5 cursor-pointer hover:opacity-90 active:scale-98 transition-all disabled:opacity-50"
              >
                {savingRoleEdit && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                บันทึก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Role Modal */}
      {roleToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-base font-black text-red-600 dark:text-red-400 mb-2">ลบบทบาทที่สร้างเอง</h3>
            <p className="text-xs text-base-content/60 leading-relaxed mb-6">
              ต้องการลบบทบาท <strong>{roleToDelete.name}</strong> ใช่หรือไม่? 
              ระบบจะลบสิทธิ์เมนูทั้งหมดของบทบาทนี้ และผู้ใช้งานที่ใช้บทบาทนี้อาจเข้าใช้งานไม่ได้
            </p>
            <div className="flex justify-end gap-2">
              <button 
                onClick={() => setRoleToDelete(null)}
                className="px-3.5 py-2 hover:bg-base-200 rounded-xl text-xs font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={() => handleDeleteRole(roleToDelete.id)}
                disabled={deletingRole}
                className="bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl px-5 py-2 text-xs transition-colors flex items-center gap-1.5 cursor-pointer active:scale-98"
              >
                {deletingRole && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                ลบบทบาท
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}