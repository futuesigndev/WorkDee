"use client"

import React, { useState, useEffect } from "react"
import { 
  Users, 
  UserPlus, 
  Search, 
  RefreshCw, 
  Shield, 
  UserCheck, 
  UserX,
  MoreVertical,
  Loader2,
  Trash2,
  X,
  ChevronUp,
  ChevronDown
} from "lucide-react"
import { cn } from "@/lib/utils"
import { API_URL } from "@/lib/api"

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([])
  const [roles, setRoles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [isProvisioning, setIsProvisioning] = useState(false)
  const [provisionId, setProvisionId] = useState("")

  // Modals & Advanced Search/Delete states
  const [showProvisionModal, setShowProvisionModal] = useState(false)
  const [searchEmpQuery, setSearchEmpQuery] = useState("")
  const [empResults, setEmpResults] = useState<any[]>([])
  const [searchingEmp, setSearchingEmp] = useState(false)
  const [selectedEmployee, setSelectedEmployee] = useState<any | null>(null)
  const [selectedRoleName, setSelectedRoleName] = useState("User")

  const [userToDelete, setUserToDelete] = useState<any | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Sorting & Pagination states
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'ascending' | 'descending' } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)


  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/users`, { credentials: "include" })
      if (res.ok) setUsers(await res.json())
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const fetchRoles = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/roles`, { credentials: "include" })
      if (res.ok) setRoles(await res.json())
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => {
    fetchUsers()
    fetchRoles()
  }, [])

  // Debounce search employee from Core-API
  useEffect(() => {
    if (!searchEmpQuery.trim()) {
      setEmpResults([])
      return
    }
    const delay = setTimeout(async () => {
      setSearchingEmp(true)
      try {
        const res = await fetch(`${API_URL}/api/v1/users/search-employees?q=${encodeURIComponent(searchEmpQuery)}`, { credentials: "include" })
        if (res.ok) {
          const data = await res.json()
          setEmpResults(data.items || [])
        }
      } catch (err) {
        console.error(err)
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
      const res = await fetch(`${API_URL}/api/v1/users/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: selectedEmployee.employee_id, role_name: selectedRoleName }),
        credentials: "include"
      })
      if (res.ok) {
        setShowProvisionModal(false)
        setSelectedEmployee(null)
        setSearchEmpQuery("")
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "Provisioning failed")
      }
    } catch (err) {
      alert("Network error")
    } finally {
      setIsProvisioning(false)
    }
  }

  const handleDeleteUser = async (employeeId: string) => {
    if (!employeeId) return
    setDeletingId(employeeId)
    try {
      const res = await fetch(`${API_URL}/api/v1/users/${employeeId}`, {
        method: "DELETE",
        credentials: "include"
      })
      if (res.ok) {
        setUserToDelete(null)
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "Deletion failed")
      }
    } catch (err) {
      alert("Network error")
    } finally {
      setDeletingId(null)
    }
  }


  const toggleUserStatus = async (employeeId: string, currentStatus: boolean) => {
    try {
      const res = await fetch(`${API_URL}/api/v1/users/${employeeId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !currentStatus }),
        credentials: "include"
      })
      if (res.ok) {
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "Failed to update user status")
      }
    } catch (err) {
      alert("Network error: Failed to update user status")
    }
  }

  const changeUserRole = async (employeeId: string, roleId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/v1/users/${employeeId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role_id: roleId }),
        credentials: "include"
      })
      if (res.ok) {
        fetchUsers()
      } else {
        const error = await res.json()
        alert(error.detail || "Failed to update user role")
      }
    } catch (err) {
      alert("Network error: Failed to update user role")
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
    let result = users.filter(u => 
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
            <Users className="text-primary" /> User Management
          </h1>
          <p className="text-base-content/50 text-sm">Provision and manage local system users</p>
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
            Provision User
          </button>
        </div>
      </div>

      <div className="bg-base-100 p-4 rounded-2xl border border-base-300 flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
          <input 
            type="text" 
            placeholder="Search by name or ID..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-base-200/50 border-none rounded-xl pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
          />
        </div>
        <button onClick={fetchUsers} className="p-2 hover:bg-base-200 rounded-lg transition-colors text-base-content/50">
          <RefreshCw size={18} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-base-200/50 border-b border-base-300">
              <tr>
                <th onClick={() => handleSort('full_name')} className="px-6 py-4 text-xs font-black uppercase tracking-wider text-base-content/50 cursor-pointer select-none hover:text-base-content transition-colors">
                  Employee {renderSortIcon('full_name')}
                </th>
                <th onClick={() => handleSort('department')} className="px-6 py-4 text-xs font-black uppercase tracking-wider text-base-content/50 cursor-pointer select-none hover:text-base-content transition-colors">
                  Details {renderSortIcon('department')}
                </th>
                <th onClick={() => handleSort('role')} className="px-6 py-4 text-xs font-black uppercase tracking-wider text-base-content/50 cursor-pointer select-none hover:text-base-content transition-colors">
                  System Role {renderSortIcon('role')}
                </th>
                <th onClick={() => handleSort('is_active')} className="px-6 py-4 text-xs font-black uppercase tracking-wider text-base-content/50 text-center cursor-pointer select-none hover:text-base-content transition-colors">
                  Status {renderSortIcon('is_active')}
                </th>
                <th className="px-6 py-4 text-xs font-black uppercase tracking-wider text-base-content/50 text-right">Actions</th>
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
                  <td colSpan={5} className="px-6 py-12 text-center text-base-content/30 italic">No users found</td>
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
                        value={u.role_id}
                        onChange={(e) => changeUserRole(u.employee_id, e.target.value)}
                        className="bg-base-200 border-none rounded-lg text-xs font-bold px-3 py-1.5 focus:ring-1 focus:ring-primary outline-none"
                      >
                        {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button 
                        onClick={() => toggleUserStatus(u.employee_id, u.is_active)}
                        className={cn(
                          "px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase transition-all cursor-pointer",
                          u.is_active 
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20" 
                            : "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                        )}
                      >
                        {u.is_active ? "Active" : "Disabled"}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={() => setUserToDelete(u)}
                        className="p-2 hover:bg-red-500/10 text-base-content/30 hover:text-red-600 rounded-lg transition-all cursor-pointer inline-flex items-center justify-center"
                        title="Delete User"
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
              Showing {Math.min((currentPage - 1) * itemsPerPage + 1, processedUsers.length)} to {Math.min(currentPage * itemsPerPage, processedUsers.length)} of {processedUsers.length} entries
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-base-content/40">Show</span>
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
                  Previous
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
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Provision Modal */}
      {showProvisionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content flex items-center gap-2">
                  <UserPlus className="text-primary" size={20} /> Provision User
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">Search employee in Core-API and grant access.</p>
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
                      placeholder="Search employee by name, nickname or ID..." 
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
                          <span className="text-[10px] bg-base-200 text-base-content/60 px-2 py-0.5 rounded-lg group-hover:bg-primary group-hover:text-white transition-all">Select</span>
                        </button>
                      ))}
                    </div>
                  ) : searchEmpQuery && !searchingEmp ? (
                    <div className="text-center py-8 text-base-content/40 italic text-sm">
                      No matching employees found in Core-API
                    </div>
                  ) : !searchEmpQuery ? (
                    <div className="text-center py-8 text-base-content/30 text-xs font-medium">
                      Start typing to search corporate database...
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
                      Change
                    </button>
                  </div>

                  {/* System Role Selection */}
                  <div className="space-y-2">
                    <label className="text-xs font-black uppercase tracking-wider text-base-content/40">Assign System Role</label>
                    <select
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
                Cancel
              </button>
              <button 
                onClick={handleProvisionSubmit}
                disabled={isProvisioning || !selectedEmployee}
                className="bg-primary text-primary-content rounded-xl px-6 py-2.5 text-sm font-bold shadow-lg shadow-primary/10 flex items-center gap-2 cursor-pointer hover:opacity-90 active:scale-98 transition-all"
              >
                {isProvisioning && <Loader2 className="w-4 h-4 animate-spin" />}
                Provision User
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-lg font-black text-red-600 dark:text-red-400 mb-2">Delete Local User</h3>
            <p className="text-xs text-base-content/60 leading-relaxed mb-6">
              Are you sure you want to delete <strong>{userToDelete.full_name}</strong> (Employee ID: {userToDelete.employee_id})? 
              This will permanently remove their local database record and system access.
              <br/><br/>
              <span className="font-semibold text-base-content/70">Note:</span> This action is local only and will not affect their record on the corporate Core-API.
            </p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setUserToDelete(null)}
                className="px-4 py-2 hover:bg-base-200 rounded-xl text-xs font-bold text-base-content/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={() => handleDeleteUser(userToDelete.employee_id)}
                disabled={deletingId !== null}
                className="bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl px-5 py-2 text-xs transition-colors flex items-center gap-2 cursor-pointer active:scale-98"
              >
                {deletingId !== null && <Loader2 className="w-4 h-4 animate-spin" />}
                Delete User
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}