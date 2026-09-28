"use client"

import React, { useState, useEffect } from 'react'
import { 
  MessageSquare, 
  Check, 
  X, 
  Clock, 
  ShieldAlert,
  Loader2,
  RefreshCw,
  Search,
  ChevronUp,
  ChevronDown,
  UserCheck,
  UserX,
  AlertTriangle,
  Link,
  ShieldCheck,
  Copy,
  QrCode
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { API_URL, apiFetch } from '@/lib/api'
import { isPermissionDenied, permissionErrorMessage } from '@/lib/errors'
import AccessDenied from '@/components/AccessDenied'

export default function LineApprovalPage() {
  const [activeTab, setActiveTab] = useState<'qrcode' | 'pending' | 'approved'>('pending')
  
  // Data lists & loading states
  const [pendingBindings, setPendingBindings] = useState<any[]>([])
  const [approvedBindings, setApprovedBindings] = useState<any[]>([])
  const [approvedTotal, setApprovedTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [processing, setProcessing] = useState<string | null>(null)

  // Search, Sort & Pagination states (Approved Tab)
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<'created_at' | 'employee_id' | 'approved_at'>('created_at')
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(5)

  // Search & Filter (Pending Tab - client side filter)
  const [pendingSearch, setPendingSearch] = useState("")

  // Pairing Modal states
  const [showPairModal, setShowPairModal] = useState(false)
  const [pairingBinding, setPairingBinding] = useState<any | null>(null)
  const [searchUserQuery, setSearchUserQuery] = useState("")
  const [userResults, setUserResults] = useState<any[]>([])
  const [searchingUsers, setSearchingUsers] = useState(false)
  
  // Repaired mappings: maps bindingId -> selected local user object
  const [repairedUsers, setRepairedUsers] = useState<{[bindingId: string]: any}>({})

  // Revocation Modal states
  const [showRevokeModal, setShowRevokeModal] = useState(false)
  const [revokingBinding, setRevokingBinding] = useState<any | null>(null)
  const [revokeReason, setRevokeReason] = useState("")
  const [submittingRevoke, setSubmittingRevoke] = useState(false)

  // Success/Error notifications
  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'error', text: string } | null>(null)
  const [dynamicLiffId, setDynamicLiffId] = useState("")

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/settings`)
        if (res.ok) {
          const data = await res.json()
          if (data.line_liff_id) {
            setDynamicLiffId(data.line_liff_id)
          }
        }
      } catch (err) {
        console.error("Failed to fetch settings for LIFF ID:", err)
      }
    }
    fetchSettings()
  }, [])

  const showNotification = (type: 'success' | 'error', text: string) => {
    setAlertMsg({ type, text })
    setTimeout(() => setAlertMsg(null), 5000)
  }

  // Fetch pending bindings (client-side paginated/filtered)
  const fetchPendingBindings = async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/pending`)
      if (res.ok) {
        setPendingBindings(await res.json())
      }
    } catch (err) {
      if (isPermissionDenied(err)) {
        setAccessDenied(true)
      } else {
        console.error(err)
        showNotification('error', 'Failed to load pending requests')
      }
    } finally {
      setLoading(false)
    }
  }

  // Fetch approved bindings (server-side paginated/filtered)
  const fetchApprovedBindings = async () => {
    setLoading(true)
    try {
      const queryParams = new URLSearchParams({
        search,
        sort_key: sortKey,
        sort_order: sortOrder,
        page: currentPage.toString(),
        page_size: itemsPerPage.toString()
      })
      const res = await apiFetch(`${API_URL}/api/v1/line/approved?${queryParams.toString()}`)
      if (res.ok) {
        const data = await res.json()
        setApprovedBindings(data.items || [])
        setApprovedTotal(data.total || 0)
      }
    } catch (err) {
      if (isPermissionDenied(err)) {
        setAccessDenied(true)
      } else {
        console.error(err)
        showNotification('error', 'Failed to load active bindings')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'pending') {
      fetchPendingBindings()
    } else {
      fetchApprovedBindings()
    }
  }, [activeTab, search, sortKey, sortOrder, currentPage, itemsPerPage])

  // Debounced search for system users to pair
  useEffect(() => {
    if (!showPairModal) return
    if (!searchUserQuery.trim()) {
      setUserResults([])
      return
    }
    const delay = setTimeout(async () => {
      setSearchingUsers(true)
      try {
        const res = await apiFetch(`${API_URL}/api/v1/users?search=${encodeURIComponent(searchUserQuery)}`)
        if (res.ok) {
          const data = await res.json()
          setUserResults(data || [])
        }
      } catch (err) {
        if (isPermissionDenied(err)) setAccessDenied(true)
        else console.error(err)
      } finally {
        setSearchingUsers(false)
      }
    }, 400)
    return () => clearTimeout(delay)
  }, [searchUserQuery, showPairModal])

  // client side filter for pending bindings
  const filteredPendingBindings = React.useMemo(() => {
    return pendingBindings.filter(b => {
      const matchedUser = repairedUsers[b.id]
      const empId = matchedUser?.employee_id || b.employee_id
      const empName = matchedUser?.full_name || b.employee_name || ''
      const lineId = b.line_user_id
      
      return empId.toLowerCase().includes(pendingSearch.toLowerCase()) ||
             empName.toLowerCase().includes(pendingSearch.toLowerCase()) ||
             lineId.toLowerCase().includes(pendingSearch.toLowerCase())
    })
  }, [pendingBindings, pendingSearch, repairedUsers])

  const handleApprove = async (id: string) => {
    setProcessing(id)
    const repairedUser = repairedUsers[id]
    const payload = repairedUser ? { employee_id: repairedUser.employee_id } : {}

    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/approve/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      
      if (res.ok) {
        showNotification('success', 'LINE Binding approved successfully!')
        // Remove repaired state
        setRepairedUsers(prev => {
          const updated = { ...prev }
          delete updated[id]
          return updated
        })
        fetchPendingBindings()
      } else {
        const errData = await res.json()
        showNotification('error', errData.detail || 'Approval failed')
      }
    } catch (err) {
      showNotification('error', permissionErrorMessage(err, 'Network error during approval'))
    } finally {
      setProcessing(null)
    }
  }

  const handleReject = async (id: string) => {
    if (!confirm('Are you sure you want to reject this request?')) return
    setProcessing(id)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/reject/${id}`, {
        method: 'POST',
      })
      if (res.ok) {
        showNotification('success', 'LINE Request rejected')
        fetchPendingBindings()
      } else {
        const errData = await res.json()
        showNotification('error', errData.detail || 'Rejection failed')
      }
    } catch (err) {
      showNotification('error', permissionErrorMessage(err, 'Network error during rejection'))
    } finally {
      setProcessing(null)
    }
  }

  const handleRevokeSubmit = async () => {
    if (!revokeReason.trim() || !revokingBinding) return
    setSubmittingRevoke(true)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/revoke/${revokingBinding.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: revokeReason }),
      })
      if (res.ok) {
        showNotification('success', 'LINE Binding revoked successfully')
        setShowRevokeModal(false)
        setRevokeReason("")
        setRevokingBinding(null)
        fetchApprovedBindings()
      } else {
        const errData = await res.json()
        showNotification('error', errData.detail || 'Revocation failed')
      }
    } catch (err) {
      showNotification('error', permissionErrorMessage(err, 'Network error during revocation'))
    } finally {
      setSubmittingRevoke(false)
    }
  }

  const openPairModal = (binding: any) => {
    setPairingBinding(binding)
    setSearchUserQuery("")
    setUserResults([])
    setShowPairModal(true)
  }

  const selectPairUser = (user: any) => {
    if (!pairingBinding) return
    setRepairedUsers(prev => ({
      ...prev,
      [pairingBinding.id]: user
    }))
    setShowPairModal(false)
    setPairingBinding(null)
    showNotification('success', `Paired request with employee ${user.full_name} (${user.employee_id})`)
  }

  const openRevokeModal = (binding: any) => {
    setRevokingBinding(binding)
    setRevokeReason("")
    setShowRevokeModal(true)
  }

  const [copied, setCopied] = useState(false)
  const liffId = dynamicLiffId || process.env.NEXT_PUBLIC_LIFF_ID || ""
  const liffUrl = `https://liff.line.me/${liffId}`
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(liffUrl)}`

  const handleCopyLink = () => {
    navigator.clipboard.writeText(liffUrl)
    setCopied(true)
    showNotification('success', 'LIFF Registration link copied to clipboard!')
    setTimeout(() => setCopied(false), 2000)
  }

  const approvedTotalPages = Math.ceil(approvedTotal / itemsPerPage)

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-6">
      {/* Toast Alert */}
      {alertMsg && (
        <div className={cn(
          "fixed bottom-5 right-5 z-50 p-4 rounded-2xl shadow-xl flex items-center gap-3 border transition-all animate-bounce",
          alertMsg.type === 'success' 
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' 
            : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
        )}>
          {alertMsg.type === 'success' ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
          <span className="text-sm font-bold">{alertMsg.text}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
            <MessageSquare className="text-[#06C755]" /> LINE OA Binding
          </h1>
          <p className="text-base-content/50 text-sm">Verify, pair, approve, and manage LINE account linking request credentials</p>
        </div>
        {activeTab !== 'qrcode' && (
          <button 
            onClick={activeTab === 'pending' ? fetchPendingBindings : fetchApprovedBindings} 
            className="p-2 hover:bg-base-200 rounded-lg transition-colors text-base-content/50"
          >
            <RefreshCw size={20} className={cn(loading && "animate-spin")} />
          </button>
        )}
      </div>

      {/* Tabs Menu */}
      <div className="flex border-b border-base-300">
        <button
          onClick={() => {
            setActiveTab('qrcode')
            setCurrentPage(1)
          }}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-tight border-b-2 transition-all cursor-pointer flex items-center gap-2",
            activeTab === 'qrcode'
              ? "border-primary text-primary"
              : "border-transparent text-base-content/50 hover:text-base-content"
          )}
        >
          <QrCode size={16} /> LIFF QR Code
        </button>

        <button
          onClick={() => {
            setActiveTab('pending')
            setLoading(true)
            setCurrentPage(1)
          }}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-tight border-b-2 transition-all cursor-pointer flex items-center gap-2",
            activeTab === 'pending'
              ? "border-primary text-primary"
              : "border-transparent text-base-content/50 hover:text-base-content"
          )}
        >
          <Clock size={16} /> Pending Requests
          {pendingBindings.length > 0 && (
            <span className="ml-1 bg-warning text-warning-content text-[10px] font-black px-2 py-0.5 rounded-full">
              {pendingBindings.length}
            </span>
          )}
        </button>
        
        <button
          onClick={() => {
            setActiveTab('approved')
            setLoading(true)
            setCurrentPage(1)
          }}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-tight border-b-2 transition-all cursor-pointer flex items-center gap-2",
            activeTab === 'approved'
              ? "border-primary text-primary"
              : "border-transparent text-base-content/50 hover:text-base-content"
          )}
        >
          <UserCheck size={16} /> Active Bindings
          {approvedTotal > 0 && (
            <span className="ml-1 bg-primary text-primary-content text-[10px] font-black px-2 py-0.5 rounded-full">
              {approvedTotal}
            </span>
          )}
        </button>
      </div>

      {/* QR Code Tab */}
      {activeTab === 'qrcode' && (
        <div className="bg-base-100 p-8 rounded-3xl border border-base-300 shadow-sm flex flex-col md:flex-row gap-8 items-center md:items-start max-w-5xl mx-auto">
          {/* Left Side of Tab: QR Code display */}
          <div className="flex flex-col items-center justify-center p-6 bg-base-200/30 rounded-2xl border border-base-300/40 relative group shrink-0 w-full md:w-auto">
            <div className="p-3 bg-white rounded-2xl shadow-md border border-base-300/50">
              <img 
                src={qrCodeUrl} 
                alt="LINE LIFF QR Code" 
                className="w-56 h-56 block"
              />
            </div>
            
            <span className="mt-4 px-3 py-1 bg-[#06C755]/10 text-[#06C755] text-[10px] font-black rounded-full uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#06C755] animate-pulse"></span>
              Auto Add Friend Enabled
            </span>
          </div>

          {/* Right Side of Tab: URL, Copy Button, Onboarding guide */}
          <div className="flex-1 space-y-6 w-full">
            <div className="flex items-center gap-3 border-b border-base-200 pb-4">
              <div className="w-10 h-10 rounded-2xl bg-[#06C755]/10 flex items-center justify-center text-[#06C755] shrink-0">
                <QrCode size={22} />
              </div>
              <div>
                <h3 className="font-black text-lg text-base-content leading-tight">LINE OA & LIFF Registration</h3>
                <p className="text-xs text-base-content/40 mt-0.5">Scan to Register Employee ID</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-base-content/40 font-bold uppercase tracking-wider block">LIFF URL Link</label>
              <div className="flex items-center gap-2">
                <input 
                  type="text" 
                  value={liffUrl}
                  readOnly
                  className="flex-1 bg-base-200 border border-base-300/50 rounded-xl px-4 py-3 text-xs font-mono text-base-content/60 outline-none select-all"
                />
                <button 
                  onClick={handleCopyLink}
                  className="p-3 bg-primary/10 text-primary hover:bg-primary hover:text-primary-content rounded-xl transition-all cursor-pointer flex items-center justify-center shrink-0 active:scale-95"
                  title="Copy link to clipboard"
                >
                  <Copy size={16} />
                </button>
              </div>
            </div>

            <div className="bg-base-200/50 p-6 rounded-2xl border border-base-300/50 text-xs text-base-content/60 space-y-3 leading-relaxed">
              <h4 className="font-bold text-sm text-base-content/80 flex items-center gap-1.5">
                💡 How to Onboard:
              </h4>
              <p className="text-[12px]">
                1. Ask the employee to scan this QR code directly from your screen or open the LIFF URL link.
              </p>
              <p className="text-[12px]">
                2. After adding the friend, the LINE app will open the registration page automatically.
              </p>
              <p className="text-[12px]">
                3. The employee inputs their Employee ID and submits.
              </p>
              <p className="text-[12px]">
                4. Approve their pending request here in this dashboard.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Pending Requests Tab */}
      {activeTab === 'pending' && (
        <div className="space-y-6">
          {/* Controls */}
          <div className="bg-base-100 p-4 rounded-2xl border border-base-300 flex items-center gap-4">
            <div className="relative flex-1 w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
              <input 
                type="text" 
                placeholder="Filter pending requests by Employee ID, Name or LINE ID..." 
                value={pendingSearch}
                onChange={(e) => setPendingSearch(e.target.value)}
                className="w-full bg-base-200/50 border-none rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
          </div>

          {/* Pending Cards List */}
          <div className="grid grid-cols-1 gap-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-20 bg-base-100 rounded-2xl border border-dashed border-base-300">
                <Loader2 className="animate-spin text-primary mb-4" size={32} />
                <span className="text-sm text-base-content/40 font-bold">Scanning for requests...</span>
              </div>
            ) : filteredPendingBindings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 bg-base-100 rounded-2xl border border-dashed border-base-300">
                <div className="w-16 h-16 bg-base-200 rounded-full flex items-center justify-center mb-4">
                  <Check className="text-base-content/20" size={32} />
                </div>
                <span className="text-sm text-base-content/40 font-bold uppercase tracking-widest">No pending requests</span>
                <p className="text-xs text-base-content/30 mt-1">All clear! No binding requests awaiting approval.</p>
              </div>
            ) : (
              filteredPendingBindings.map((item) => {
                const repairedUser = repairedUsers[item.id]
                const finalEmpId = repairedUser?.employee_id || item.employee_id
                const finalEmpName = repairedUser?.full_name || item.employee_name
                const finalDept = repairedUser?.department || item.department
                const isRepaired = !!repairedUser

                return (
                  <div key={item.id} className="bg-base-100 p-6 rounded-2xl border border-base-300 flex flex-col lg:flex-row lg:items-center justify-between gap-6 hover:shadow-lg hover:shadow-base-content/5 transition-all group">
                    <div className="flex items-start gap-5">
                      <div className="relative shrink-0">
                         <div className="w-14 h-14 rounded-2xl bg-[#06C755]/10 flex items-center justify-center text-[#06C755]">
                           <MessageSquare size={28} />
                         </div>
                         <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-warning rounded-full border-2 border-base-100 flex items-center justify-center">
                           <Clock size={10} className="text-warning-content" />
                         </div>
                      </div>
                      
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-black text-lg tracking-tight">Employee: {finalEmpName || 'Unassigned / Mismatch'}</span>
                          <span className="px-2.5 py-0.5 bg-base-200 text-base-content/60 text-[10px] font-black rounded-full uppercase tracking-wider">
                            ID: {finalEmpId}
                          </span>
                          {isRepaired && (
                            <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] font-black rounded-full uppercase tracking-wider">
                              Re-paired
                            </span>
                          )}
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/50">
                          <div className="font-mono text-[11px] bg-base-200 px-2 py-0.5 rounded text-base-content/70">
                             LINE User ID: {item.line_user_id}
                          </div>
                          {finalDept && (
                            <>
                              <div className="w-1.5 h-1.5 bg-base-content/20 rounded-full hidden sm:block"></div>
                              <div>Dept: {finalDept} {item.company ? `(${item.company})` : ''}</div>
                            </>
                          )}
                          <div className="w-1.5 h-1.5 bg-base-content/20 rounded-full hidden sm:block"></div>
                          <div>Requested: {new Date(item.created_at).toLocaleString()}</div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button 
                         onClick={() => openPairModal(item)}
                         disabled={!!processing}
                         className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl border border-primary/20 text-primary font-bold text-xs hover:bg-primary/5 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                      >
                        Change/Pair Employee
                      </button>
                      <button 
                         onClick={() => handleReject(item.id)}
                         disabled={!!processing}
                         className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl border border-error/20 text-error font-bold text-xs hover:bg-error hover:text-error-content transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                      >
                        Reject
                      </button>
                      <button 
                         onClick={() => handleApprove(item.id)}
                         disabled={!!processing}
                         className="flex-1 sm:flex-none px-5 py-2.5 rounded-xl bg-success text-success-content font-bold text-xs hover:opacity-90 shadow-lg shadow-success/20 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        {processing === item.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Approve Binding
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* Active Bindings Tab */}
      {activeTab === 'approved' && (
        <div className="space-y-6">
          {/* Filters and Search */}
          <div className="bg-base-100 p-4 rounded-2xl border border-base-300 flex flex-col md:flex-row items-center gap-4 justify-between">
            <div className="relative flex-1 w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
              <input 
                type="text" 
                placeholder="Search active bindings by Employee Name, ID, Dept, or LINE ID..." 
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setCurrentPage(1)
                }}
                className="w-full bg-base-200/50 border-none rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            
            <div className="flex items-center gap-3 w-full md:w-auto justify-end shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-base-content/40">Sort by</span>
                <select
                  value={sortKey}
                  onChange={(e) => {
                    setSortKey(e.target.value as any)
                    setCurrentPage(1)
                  }}
                  className="bg-base-200 border-none rounded-lg px-2.5 py-1.5 outline-none font-bold text-xs cursor-pointer"
                >
                  <option value="created_at">Date Requested</option>
                  <option value="approved_at">Date Approved</option>
                  <option value="employee_id">Employee ID</option>
                </select>
              </div>
              
              <button
                onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                className="p-2.5 hover:bg-base-200 rounded-lg text-base-content/50 transition-colors cursor-pointer flex items-center justify-center"
                title={sortOrder === 'asc' ? 'Sort Descending' : 'Sort Ascending'}
              >
                {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
          </div>

          {/* Active Bindings Table */}
          <div className="bg-base-100 rounded-3xl border border-base-300 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="table w-full text-left border-collapse">
                <thead>
                  <tr className="bg-base-200/50 border-b border-base-300 text-xs font-bold text-base-content/50 uppercase tracking-widest">
                    <th className="px-6 py-4">Employee</th>
                    <th className="px-6 py-4">LINE User ID</th>
                    <th className="px-6 py-4">Department</th>
                    <th className="px-6 py-4">Approved By / At</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-300 text-sm">
                  {loading ? (
                    [1, 2, 3].map(i => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={5} className="px-6 py-8">
                          <div className="h-4 bg-base-200 rounded w-full"></div>
                        </td>
                      </tr>
                    ))
                  ) : approvedBindings.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-base-content/30 italic">
                        No active LINE bindings found
                      </td>
                    </tr>
                  ) : (
                    approvedBindings.map((u) => (
                      <tr key={u.id} className="hover:bg-base-200/30 transition-colors group">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 font-bold shrink-0">
                              {u.employee_name?.charAt(0) || 'U'}
                            </div>
                            <div>
                              <div className="font-bold text-sm text-base-content">{u.employee_name || 'N/A'}</div>
                              <div className="text-[10px] text-base-content/40 font-mono bg-base-200 px-1.5 py-0.5 rounded inline-block mt-0.5">
                                #{u.employee_id}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-mono text-xs text-base-content/60 truncate max-w-[200px]" title={u.line_user_id}>
                            {u.line_user_id}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs text-base-content/70">{u.department || '-'}</div>
                          <div className="text-[10px] text-base-content/40">{u.division || ''}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs text-base-content/80">By: {u.approved_by || 'System'}</div>
                          <div className="text-[10px] text-base-content/40">
                            {u.approved_at ? new Date(u.approved_at).toLocaleString() : '-'}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => openRevokeModal(u)}
                            className="px-3.5 py-1.5 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 text-xs font-bold rounded-xl transition-all cursor-pointer inline-flex items-center gap-1.5 active:scale-95"
                          >
                            <UserX size={14} /> Revoke
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Table Pagination */}
            {approvedTotal > 0 && (
              <div className="bg-base-100 p-4 border-t border-base-300 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
                <div className="text-base-content/50">
                  Showing {Math.min((currentPage - 1) * itemsPerPage + 1, approvedTotal)} to {Math.min(currentPage * itemsPerPage, approvedTotal)} of {approvedTotal} entries
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
                    {Array.from({ length: approvedTotalPages }, (_, i) => i + 1).map((page) => (
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
                      onClick={() => setCurrentPage(prev => Math.min(prev + 1, approvedTotalPages))}
                      disabled={currentPage === approvedTotalPages || approvedTotalPages === 0}
                      className="px-3 py-1.5 bg-base-200 hover:bg-base-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-bold transition-colors cursor-pointer"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Change/Pair Employee Modal */}
      {showPairModal && pairingBinding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[80vh] animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content flex items-center gap-2">
                  <Link className="text-primary" size={20} /> Pair Request with Employee
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">Select a system user to link with this LINE account.</p>
              </div>
              <button 
                onClick={() => {
                  setShowPairModal(false)
                  setPairingBinding(null)
                }}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 flex-1 overflow-y-auto space-y-4">
              <div className="bg-base-200/50 p-3 rounded-2xl border border-base-300 text-xs flex flex-col gap-1">
                <span className="font-mono text-base-content/50">LINE User ID: {pairingBinding.line_user_id}</span>
                <span className="font-bold text-base-content/70">Original Request Employee ID: {pairingBinding.employee_id}</span>
              </div>
              
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
                <input 
                  type="text" 
                  placeholder="Search local employees by name or ID..." 
                  value={searchUserQuery}
                  onChange={(e) => setSearchUserQuery(e.target.value)}
                  className="w-full bg-base-200/80 border-none rounded-xl pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                  autoFocus
                />
              </div>

              {/* Search Results */}
              <div className="space-y-2 mt-4 max-h-[40vh] overflow-y-auto">
                {searchingUsers ? (
                  <div className="flex items-center justify-center py-10 text-xs text-base-content/40 font-bold gap-2">
                    <Loader2 size={16} className="animate-spin text-primary" /> Searching...
                  </div>
                ) : userResults.length === 0 ? (
                  <div className="text-center py-10 text-xs text-base-content/40 italic">
                    {searchUserQuery ? 'No system employees match search query' : 'Type to search employees'}
                  </div>
                ) : (
                  userResults.map((user) => (
                    <div 
                      key={user.id} 
                      onClick={() => selectPairUser(user)}
                      className="p-4 bg-base-200/50 hover:bg-primary/5 hover:border-primary/20 border border-transparent rounded-2xl flex items-center justify-between gap-4 cursor-pointer transition-all active:scale-98 group"
                    >
                      <div>
                        <span className="font-bold text-sm text-base-content block group-hover:text-primary transition-colors">{user.full_name}</span>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-base-content/50">
                          <span className="font-mono bg-base-300/60 px-1.5 py-0.5 rounded text-[10px]">ID: {user.employee_id}</span>
                          <span>|</span>
                          <span>{user.department}</span>
                        </div>
                      </div>
                      <button className="px-3.5 py-1.5 bg-primary/10 text-primary hover:bg-primary hover:text-primary-content text-xs font-bold rounded-xl transition-all">
                        Select
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Revocation Reason Modal */}
      {showRevokeModal && revokingBinding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <div>
                <h2 className="text-lg font-black tracking-tight text-base-content flex items-center gap-2">
                  <UserX className="text-red-500" size={20} /> Revoke LINE Binding
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">Please provide a reason to revoke this binding permission.</p>
              </div>
              <button 
                onClick={() => {
                  setShowRevokeModal(false)
                  setRevokingBinding(null)
                  setRevokeReason("")
                }}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-4">
              <div className="bg-red-500/5 p-4 border border-red-500/10 rounded-2xl flex gap-3 text-xs text-red-600 dark:text-red-400">
                <AlertTriangle className="shrink-0" size={18} />
                <div>
                  <h4 className="font-bold">Warning: Access Removal</h4>
                  <p className="mt-0.5 opacity-90">Revoking this binding will disconnect Employee <strong>{revokingBinding.employee_name} ({revokingBinding.employee_id})</strong> from receiving push notifications via this LINE account.</p>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-base-content/50">Revocation Reason</label>
                <textarea 
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  placeholder="e.g. Employee requested change, Mobile device lost, Left company..."
                  rows={3}
                  className="w-full bg-base-200 border border-base-300/55 rounded-2xl p-3 text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                  autoFocus
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-6 border-t border-base-300 flex justify-end gap-3 bg-base-200/50">
              <button
                onClick={() => {
                  setShowRevokeModal(false)
                  setRevokingBinding(null)
                  setRevokeReason("")
                }}
                disabled={submittingRevoke}
                className="px-5 py-2.5 border border-base-300 hover:bg-base-200 font-bold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeSubmit}
                disabled={submittingRevoke || !revokeReason.trim()}
                className="px-5 py-2.5 bg-red-600 text-white hover:bg-red-700 font-bold text-xs rounded-xl shadow-lg shadow-red-500/20 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {submittingRevoke ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />}
                Confirm Revocation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Security Info Card */}
      <div className="bg-warning/10 p-5 rounded-3xl border border-warning/20 flex items-start gap-4">
        <ShieldAlert className="text-warning mt-0.5 shrink-0" size={22} />
        <div>
          <h4 className="text-sm font-black text-warning-content">System Binding Constraints & Enforcement</h4>
          <p className="text-xs text-warning-content/70 mt-1 leading-relaxed">
            - <strong>1 LINE per Employee:</strong> Approving a new LINE binding will automatically revoke the old LINE binding configuration of that employee.<br />
            - <strong>1 Employee per LINE:</strong> A single LINE account cannot be actively paired with multiple employees at the same time. If a duplicate active LINE ID is detected, the approval will be blocked.<br />
            - <strong>Audit Trail:</strong> All approval and revocation actions are fully audited and visible under the Activity Logs page.
          </p>
        </div>
      </div>
    </div>
  )
}
