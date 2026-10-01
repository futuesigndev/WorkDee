"use client"

import React, { useState, useEffect } from "react"
import { 
  Users, 
  UserPlus, 
  Search, 
  RefreshCw, 
  Loader2,
  Trash2,
  X,
  ChevronUp,
  ChevronDown
} from "lucide-react"
import { cn } from "@/lib/utils"
import { API_URL, apiFetch } from "@/lib/api"
import { isPermissionDenied, permissionErrorMessage } from "@/lib/errors"
import AccessDenied from "@/components/AccessDenied"

export default function UsersPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- user rows are the API's shape and have no frontend type yet; typing them is a design task (032)
  const [users, setUsers] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- role rows are the API's shape, not modelled in the frontend yet (032)
  const [roles, setRoles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [search, setSearch] = useState("")
  const [isProvisioning, setIsProvisioning] = useState(false)

  // Modals & Advanced Search/Delete states
  const [showProvisionModal, setShowProvisionModal] = useState(false)
  const [searchEmpQuery, setSearchEmpQuery] = useState("")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Core-API employee search rows have no frontend type yet (032)
  const [empResults, setEmpResults] = useState<any[]>([])
  const [searchingEmp, setSearchingEmp] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- selected Core-API employee record; shape not modelled in the frontend yet (032)
  const [selectedEmployee, setSelectedEmployee] = useState<any | null>(null)
  const [selectedRoleName, setSelectedRoleName] = useState("User")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- user row pending deletion; shape not modelled in the frontend yet (032)
  const [userToDelete, setUserToDelete] = useState<any | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Task 047/D9: the status pill asks first, because deactivating revokes the session the person is
  // holding at that moment (task 023). Nothing is sent unless the admin confirms in the panel.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- user row awaiting a status change; shape not modelled yet (032)
  const [userToToggle, setUserToToggle] = useState<any | null>(null)
  const [togglingStatus, setTogglingStatus] = useState(false)

  // Sorting & Pagination states
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'ascending' | 'descending' } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)


  const fetchUsers = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/v1/users`)
      if (res.ok) setUsers(await res.json())
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const fetchRoles = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/v1/roles`)
      if (res.ok) setRoles(await res.json())
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error(err)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading the user and role lists into state on mount is the purpose of this effect (032)
    fetchUsers()
    fetchRoles()
  }, [])

  // Debounce search employee from Core-API
  useEffect(() => {
    if (!searchEmpQuery.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the stale result list before the debounce fires is deliberate (032)
      setEmpResults([])
      return
    }
    const delay = setTimeout(async () => {
      setSearchingEmp(true)
      try {
        const res = await apiFetch(`${API_URL}/api/v1/users/search-employees?q=${encodeURIComponent(searchEmpQuery)}`)
        if (res.ok) {
          const data = await res.json()
          setEmpResults(data.items || [])
        }
      } catch (err) {
        if (isPermissionDenied(err)) setAccessDenied(true)
        else console.error(err)
      } finally {
        setSearchingEmp(false)
      }
    }, 400)
    return () => clearTimeout(delay)
  }, [searchEmpQuery])

  const handleProvisionSubmit = async () => {
    if (!selectedEmployee) return
    setIsProvisioning(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/users/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: selectedEmployee.employee_id, role_name: selectedRoleName }),
      })
      if (res.ok) {
        setShowProvisionModal(false)
        setSelectedEmployee(null)
        setSearchEmpQuery("")
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "เพิ่มผู้ใช้งานไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"))
    } finally {
      setIsProvisioning(false)
    }
  }

  const handleDeleteUser = async (employeeId: string) => {
    if (!employeeId) return
    setDeletingId(employeeId)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/users/${employeeId}`, {
        method: "DELETE",
      })
      if (res.ok) {
        setUserToDelete(null)
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "ลบไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"))
    } finally {
      setDeletingId(null)
    }
  }


  /**
   * Only the confirm button of the status panel reaches here. A deactivated user is signed out on
   * their very next request (023), which is exactly why the panel spells that out before it happens.
   */
  const applyUserStatus = async (user: { employee_id: string; is_active: boolean }) => {
    setTogglingStatus(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/users/${user.employee_id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !user.is_active }),
      })
      if (res.ok) {
        setUserToToggle(null)
        fetchUsers()
      } else {
        // A refusal has a Thai `detail` (e.g. the last active admin, or your own account); a bodyless
        // error must not send the admin to the catch below with a network-flavoured message (045/D5).
        const error = await res.json().catch(() => null)
        alert(error?.detail || "แก้ไขสถานะไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"))
    } finally {
      setTogglingStatus(false)
    }
  }

  const changeUserRole = async (employeeId: string, roleId: string) => {
    try {
      const res = await apiFetch(`${API_URL}/api/v1/users/${employeeId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role_id: roleId }),
      })
      if (res.ok) {
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "แก้ไขบทบาทไม่สำเร็จ")
      }
    } catch (err) {
      alert(permissionErrorMessage(err, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"))
    }
  }

  const handleSort = (key: string) => {
    let direction: 'ascending' | 'descending' = 'ascending'
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending'
    }
    setSortConfig({ key, direction })
    setCurrentPage(1)
  }

  const renderSortIcon = (key: string) => {
    if (!sortConfig || sortConfig.key !== key) {
      return <ChevronDown size={12} className="opacity-30 inline-block ml-1" />
    }
    return sortConfig.direction === 'ascending' 
      ? <ChevronUp size={12} className="text-primary inline-block ml-1" /> 
      : <ChevronDown size={12} className="text-primary inline-block ml-1" />
  }

  const processedUsers = React.useMemo(() => {
    const result = users.filter(u => 
      u.full_name.toLowerCase().includes(search.toLowerCase()) || 
      u.employee_id.includes(search) ||
      u.department.toLowerCase().includes(search.toLowerCase()) ||
      u.division.toLowerCase().includes(search.toLowerCase())
    )

    if (sortConfig !== null) {
      result.sort((a, b) => {
        let aVal = a[sortConfig.key] || ""
        let bVal = b[sortConfig.key] || ""

        if (sortConfig.key === 'role') {
          aVal = a.role_name || ""
          bVal = b.role_name || ""
        }

        if (typeof aVal === 'string') {
          return sortConfig.direction === 'ascending'
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal)
        }

        if (aVal < bVal) return sortConfig.direction === 'ascending' ? -1 : 1
        if (aVal > bVal) return sortConfig.direction === 'ascending' ? 1 : -1
        return 0
      })
    }
    return result
  }, [users, search, sortConfig])

  const totalPages = Math.ceil(processedUsers.length / itemsPerPage)
  const paginatedUsers = React.useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage
    return processedUsers.slice(start, start + itemsPerPage)
  }, [processedUsers, currentPage, itemsPerPage])

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
            <Users className="text-primary" /> ผู้ใช้งาน
          </h1>
          <p className="text-base-content/50 text-sm font-bold">เพิ่มและดูแลผู้ใช้งานในระบบ</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setSelectedEmployee(null)
              setSearchEmpQuery("")
              setSelectedRoleName("User")
              setShowProvisionModal(true)
            }}
            className="bg-primary text-primary-content flex items-center gap-2 h-10 px-6 font-bold shadow-lg shadow-primary/20 rounded-xl cursor-pointer hover:scale-102 active:scale-98 transition-all"
          >
            <UserPlus size={16} />
            เพิ่มผู้ใช้งาน
          </button>
        </div>
      </div>

      <div className="bg-base-100 p-4 rounded-2xl border border-base-300 flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
          <input 
            type="text" 
            placeholder="ค้นหาชื่อ รหัสพนักงาน แผนก หรือฝ่าย" 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-base-200/50 border-none rounded-xl pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
          />
        </div>
        <button onClick={fetchUsers} aria-label="โหลดรายการผู้ใช้งานใหม่" className="p-2 hover:bg-base-200 rounded-lg transition-colors text-base-content/50">
          <RefreshCw size={18} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-base-200/50 border-b border-base-300">
              <tr>
                <th onClick={() => handleSort('full_name')} className="px-6 py-4 text-xs font-black text-base-content/50 cursor-pointer select-none hover:text-base-content transition-colors">
                  พนักงาน {renderSortIcon('full_name')}
                </th>
                <th onClick={() => handleSort('department')} className="px-6 py-4 text-xs font-black text-base-content/50 cursor-pointer select-none hover:text-base-content transition-colors">
                  แผนก / ฝ่าย {renderSortIcon('department')}
                </th>
                <th onClick={() => handleSort('role')} className="px-6 py-4 text-xs font-black text-base-content/50 cursor-pointer select-none hover:text-base-content transition-colors">
                  บทบาทในระบบ {renderSortIcon('role')}
                </th>
                <th onClick={() => handleSort('is_active')} className="px-6 py-4 text-xs font-black text-base-content/50 text-center cursor-pointer select-none hover:text-base-content transition-colors">
                  สถานะ {renderSortIcon('is_active')}
                </th>
                <th className="px-6 py-4 text-xs font-black text-base-content/50 text-right">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-300">
              {loading ? (
                [1,2,3].map(i => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={5} className="px-6 py-8"><div className="h-4 bg-base-200 rounded w-full"></div></td>
                  </tr>
                ))
              ) : paginatedUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-base-content/30 italic">ไม่พบผู้ใช้งาน</td>
                </tr>
              ) : (
                paginatedUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-base-200/30 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                          {u.full_name.charAt(0)}
                        </div>
                        <div>
                          <div className="font-bold text-sm">{u.full_name}</div>
                          <div className="text-[10px] text-base-content/40 font-mono uppercase bg-base-200 px-1.5 py-0.5 rounded inline-block mt-0.5">#{u.employee_id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs text-base-content/70">{u.department}</div>
                      <div className="text-[10px] text-base-content/40">{u.division}</div>
                    </td>
                    <td className="px-6 py-4">
                      <select 
                        aria-label={`บทบาทของ ${u.full_name}`}
                        value={u.role_id}
                        onChange={(e) => changeUserRole(u.employee_id, e.target.value)}
                        className="bg-base-200 border-none rounded-lg text-xs font-bold px-3 py-1.5 focus:ring-1 focus:ring-primary outline-none"
                      >
                        {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button 
                        onClick={() => setUserToToggle(u)}
                        aria-label={u.is_active ? `ปิดใช้งาน ${u.full_name}` : `เปิดใช้งาน ${u.full_name}`}
                        className={cn(
                          "px-3 py-1 rounded-full text-[10px] font-black transition-all cursor-pointer",
                          u.is_active 
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20" 
                            : "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                        )}
                      >
                        {u.is_active ? "ใช้งาน" : "ปิดใช้งาน"}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={() => setUserToDelete(u)}
                        className="p-2 hover:bg-red-500/10 text-base-content/30 hover:text-red-600 rounded-lg transition-all cursor-pointer inline-flex items-center justify-center"
                        title="ลบผู้ใช้งาน"
                        aria-label={`ลบผู้ใช้งาน ${u.full_name}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        {/* Pagination Footer */}
        {processedUsers.length > 0 && (
          <div className="bg-base-100 p-4 border-t border-base-300 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
            <div className="text-base-content/50">
              แสดง {Math.min((currentPage - 1) * itemsPerPage + 1, processedUsers.length)}–{Math.min(currentPage * itemsPerPage, processedUsers.length)} จาก {processedUsers.length} รายการ
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-base-content/40">จำนวนต่อหน้า</span>
                <select
                  value={itemsPerPage}
                  onChange={(e) => {
                    setItemsPerPage(Number(e.target.value))
                    setCurrentPage(1)
                  }}
                  className="bg-base-200 border-none rounded-lg px-2.5 py-1 outline-none font-bold text-xs cursor-pointer"
                >
                  {[5, 10, 20, 50].map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1.5 ml-4">
                <button
                  onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 bg-base-200 hover:bg-base-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-bold transition-colors cursor-pointer"
                >
                  ก่อนหน้า
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer",
                      currentPage === page 
                        ? "bg-primary text-primary-content shadow-md" 
                        : "bg-base-200 hover:bg-base-300 text-base-content"
                    )}
                  >
                    {page}
                  </button>
                ))}
                <button
                  onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                  disabled={currentPage === totalPages || totalPages === 0}
                  className="px-3 py-1.5 bg-base-200 hover:bg-base-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-bold transition-colors cursor-pointer"
                >
                  ถัดไป
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Status confirmation panel (task 047/D9) — the pill opens this; only "ยืนยัน" writes */}
      {userToToggle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-200">
            <h3 className={cn(
              "text-base font-black mb-2",
              userToToggle.is_active ? "text-error" : "text-primary"
            )}>
              {userToToggle.is_active ? "ปิดใช้งานผู้ใช้งาน" : "เปิดใช้งานผู้ใช้งาน"}
            </h3>
            <p className="text-xs text-base-content/60 leading-relaxed mb-6">
              {userToToggle.is_active ? (
                <>
                  ต้องการปิดใช้งาน <strong>{userToToggle.full_name}</strong> ใช่หรือไม่? ผู้ใช้รายนี้จะเข้าใช้งานไม่ได้ทันที
                  และ <strong>เซสชันที่กำลังใช้งานอยู่จะถูกออกจากระบบ</strong> ข้อมูลเดิมยังอยู่ครบและเปิดใช้งานกลับได้ทุกเมื่อ
                </>
              ) : (
                <>
                  ต้องการเปิดใช้งาน <strong>{userToToggle.full_name}</strong> ใช่หรือไม่? ผู้ใช้รายนี้จะกลับเข้าใช้งานระบบได้อีกครั้ง
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setUserToToggle(null)}
                className="px-3.5 py-2 hover:bg-base-200 rounded-xl text-xs font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                onClick={() => applyUserStatus(userToToggle)}
                disabled={togglingStatus}
                className={cn(
                  "text-xs font-bold rounded-xl px-5 py-2 transition-all flex items-center gap-1.5 cursor-pointer active:scale-98 disabled:opacity-50",
                  userToToggle.is_active
                    ? "bg-error text-error-content hover:opacity-90"
                    : "bg-primary text-primary-content hover:opacity-90"
                )}
              >
                {togglingStatus && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {userToToggle.is_active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Provision Modal */}
      {showProvisionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content flex items-center gap-2">
                  <UserPlus className="text-primary" size={20} /> เพิ่มผู้ใช้งาน
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">ค้นหาพนักงานจาก Core-API แล้วให้สิทธิ์เข้าใช้งาน</p>
              </div>
              <button 
                onClick={() => setShowProvisionModal(false)}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 flex-1 overflow-y-auto space-y-6">
              {!selectedEmployee ? (
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
                    <input 
                      type="text" 
                      placeholder="ค้นหาพนักงานด้วยชื่อ ชื่อเล่น หรือรหัสพนักงาน" 
                      value={searchEmpQuery}
                      onChange={(e) => setSearchEmpQuery(e.target.value)}
                      className="w-full bg-base-200 border-none rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                    {searchingEmp && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 text-primary animate-spin" size={18} />
                    )}
                  </div>

                  {/* Results */}
                  {empResults.length > 0 ? (
                    <div className="border border-base-300 rounded-2xl overflow-hidden divide-y divide-base-300 max-h-60 overflow-y-auto bg-base-50">
                      {empResults.map((emp) => (
                        <button
                          key={emp.employee_id}
                          onClick={() => {
                            setSelectedEmployee(emp)
                            setSearchEmpQuery("")
                            setEmpResults([])
                          }}
                          className="w-full text-left p-3.5 hover:bg-primary/5 transition-colors flex items-center justify-between group cursor-pointer"
                        >
                          <div>
                            <div className="text-sm font-bold text-base-content group-hover:text-primary transition-colors">{emp.full_name}</div>
                            <div className="text-[10px] text-base-content/40 font-mono mt-0.5">#{emp.employee_id} • {emp.department} • {emp.division}</div>
                          </div>
                          <span className="text-[10px] bg-base-200 text-base-content/60 px-2 py-0.5 rounded-lg group-hover:bg-primary group-hover:text-white transition-all">เลือก</span>
                        </button>
                      ))}
                    </div>
                  ) : searchEmpQuery && !searchingEmp ? (
                    <div className="text-center py-8 text-base-content/40 italic text-sm">
                      ไม่พบพนักงานที่ตรงกันใน Core-API
                    </div>
                  ) : !searchEmpQuery ? (
                    <div className="text-center py-8 text-base-content/30 text-xs font-medium">
                      พิมพ์เพื่อค้นหารายชื่อพนักงาน
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Selected Employee Card */}
                  <div className="bg-primary/5 border border-primary/10 rounded-2xl p-5 relative overflow-hidden">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center text-primary font-black text-lg">
                        {selectedEmployee.full_name.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-base-content truncate">{selectedEmployee.full_name}</div>
                        <div className="text-[11px] text-base-content/40 font-mono mt-0.5">#{selectedEmployee.employee_id}</div>
                        <div className="text-[11px] text-base-content/60 mt-1 font-medium">{selectedEmployee.department} • {selectedEmployee.division}</div>
                        <div className="text-[10px] text-base-content/40 font-semibold uppercase mt-0.5 tracking-wider">{selectedEmployee.company_name || selectedEmployee.company || selectedEmployee.company_abb}</div>
                      </div>
                    </div>
                    
                    <button 
                      onClick={() => setSelectedEmployee(null)}
                      className="absolute top-4 right-4 text-xs font-black text-primary hover:text-primary-focus underline cursor-pointer"
                    >
                      เปลี่ยน
                    </button>
                  </div>

                  {/* System Role Selection */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-base-content/40">กำหนดบทบาทในระบบ</label>
                    <select
                      aria-label="กำหนดบทบาทในระบบ"
                      value={selectedRoleName}
                      onChange={(e) => setSelectedRoleName(e.target.value)}
                      className="w-full bg-base-200 border-none rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none font-bold"
                    >
                      {roles.map((r) => (
                        <option key={r.id} value={r.name}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    {roles.length === 0 && (
                      <p className="text-[11px] font-bold text-warning">
                        โหลดรายการบทบาทไม่สำเร็จ ระบบจะเพิ่มผู้ใช้ด้วยบทบาท User
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-base-300 flex justify-end gap-3 bg-base-200/50">
              <button 
                onClick={() => setShowProvisionModal(false)}
                className="px-4 py-2.5 hover:bg-base-300 rounded-xl text-sm font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={handleProvisionSubmit}
                disabled={isProvisioning || !selectedEmployee}
                className="bg-primary text-primary-content rounded-xl px-6 py-2.5 text-sm font-bold shadow-lg shadow-primary/10 flex items-center gap-2 cursor-pointer hover:opacity-90 active:scale-98 transition-all"
              >
                {isProvisioning && <Loader2 className="w-4 h-4 animate-spin" />}
                เพิ่มผู้ใช้งาน
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-lg font-black text-red-600 dark:text-red-400 mb-2">ลบผู้ใช้งาน</h3>
            <p className="text-xs text-base-content/60 leading-relaxed mb-6">
              ต้องการลบ <strong>{userToDelete.full_name}</strong> (รหัสพนักงาน: {userToDelete.employee_id}) ใช่หรือไม่? 
              ระบบจะลบข้อมูลผู้ใช้งานรายนี้ออกจากฐานข้อมูล และตัดสิทธิ์เข้าใช้งานทันที
              <br/><br/>
              <span className="font-semibold text-base-content/70">หมายเหตุ:</span> ลบเฉพาะในแอปนี้ ไม่กระทบข้อมูลใน Core-API
            </p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setUserToDelete(null)}
                className="px-4 py-2 hover:bg-base-200 rounded-xl text-xs font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={() => handleDeleteUser(userToDelete.employee_id)}
                disabled={deletingId !== null}
                className="bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl px-5 py-2 text-xs transition-colors flex items-center gap-2 cursor-pointer active:scale-98"
              >
                {deletingId !== null && <Loader2 className="w-4 h-4 animate-spin" />}
                ลบผู้ใช้งาน
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}