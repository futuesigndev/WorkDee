"use client"

import React, { useState, useEffect } from 'react'
import Image from "next/image"
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
  Download,
  UserCheck,
  UserX,
  UserPlus,
  AlertTriangle,
  Link,
  ShieldCheck,
  Copy,
  QrCode,
  LayoutGrid
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatThaiDateTime } from '@/lib/datetime'
import { API_URL, apiFetch } from '@/lib/api'
import { isPermissionDenied, permissionErrorMessage } from '@/lib/errors'
import AccessDenied from '@/components/AccessDenied'

export default function LineApprovalPage() {
  const [activeTab, setActiveTab] = useState<'qrcode' | 'addfriend' | 'pending' | 'approved'>('pending')
  
  // Data lists & loading states
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LINE binding rows are the API's shape and have no frontend type yet; typing them is a design task (032)
  const [pendingBindings, setPendingBindings] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same API row shape as pendingBindings (032)
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- binding row being paired; API shape, not modelled in the frontend yet (032)
  const [pairingBinding, setPairingBinding] = useState<any | null>(null)
  const [searchUserQuery, setSearchUserQuery] = useState("")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- local-user search results from the API; shape not modelled yet (032)
  const [userResults, setUserResults] = useState<any[]>([])
  const [searchingUsers, setSearchingUsers] = useState(false)
  
  // Repaired mappings: maps bindingId -> selected local user object
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- repaired bindingId → user mapping; the user shape is the API's (032)
  const [repairedUsers, setRepairedUsers] = useState<{[bindingId: string]: any}>({})

  // Revocation Modal states
  const [showRevokeModal, setShowRevokeModal] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- binding row being revoked; API shape, not modelled in the frontend yet (032)
  const [revokingBinding, setRevokingBinding] = useState<any | null>(null)
  const [revokeReason, setRevokeReason] = useState("")
  const [submittingRevoke, setSubmittingRevoke] = useState(false)

  // Success/Error notifications
  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'warning' | 'error', text: string } | null>(null)
  const [dynamicLiffId, setDynamicLiffId] = useState("")
  const [lineBasicId, setLineBasicId] = useState("")

  // --- Employee Rich Menu card (task 025) ---------------------------------------------
  // The rest of this page speaks English; this card is Thai on purpose (it is the one piece an HR
  // admin uses to publish something employees will see inside LINE).
  type RichMenuStatus = {
    menu_name: string
    menu_exists: boolean
    menu_id_suffix: string | null
    approved_bindings: number
    channel_token_configured: boolean
    liff_id_configured: boolean
    note_th: string
  }
  type RichMenuPublishResult = {
    menu_created: boolean
    menu_id_suffix: string | null
    approved_bindings: number
    linked: number
    failed: number
    skipped: number
  }
  const [menuStatus, setMenuStatus] = useState<RichMenuStatus | null>(null)
  const [menuLoading, setMenuLoading] = useState(true)
  const [menuRunning, setMenuRunning] = useState(false)
  const [menuError, setMenuError] = useState("")
  const [menuResult, setMenuResult] = useState<RichMenuPublishResult | null>(null)
  const [showMenuConfirm, setShowMenuConfirm] = useState(false)

  const fetchMenuStatus = async () => {
    setMenuLoading(true)
    setMenuError("")
    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/rich-menu/status`)
      if (res.ok) {
        setMenuStatus(await res.json())
      } else {
        setMenuError("อ่านสถานะเมนูไม่สำเร็จ")
      }
    } catch (err) {
      if (isPermissionDenied(err)) {
        setAccessDenied(true)
      } else {
        console.error(err)
        setMenuError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
      }
    } finally {
      setMenuLoading(false)
    }
  }

  // The first read is written out here instead of calling `fetchMenuStatus` so that no state is set
  // synchronously inside the effect (the same shape the settings fetch above already uses).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/v1/line/rich-menu/status`)
        if (cancelled) return
        if (res.ok) {
          setMenuStatus(await res.json())
        } else {
          setMenuError("อ่านสถานะเมนูไม่สำเร็จ")
        }
      } catch (err) {
        if (cancelled) return
        if (isPermissionDenied(err)) {
          setAccessDenied(true)
        } else {
          console.error(err)
          setMenuError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
        }
      } finally {
        if (!cancelled) setMenuLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const publishMenu = async () => {
    setShowMenuConfirm(false)
    setMenuRunning(true)
    setMenuError("")
    setMenuResult(null)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/rich-menu/publish`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setMenuError(data?.detail || "สร้างเมนูไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
      } else {
        setMenuResult(data)
        await fetchMenuStatus()
      }
    } catch (err) {
      if (isPermissionDenied(err)) {
        setAccessDenied(true)
      } else {
        console.error(err)
        setMenuError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
      }
    } finally {
      setMenuRunning(false)
    }
  }

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/settings`)
        if (res.ok) {
          const data = await res.json()
          if (data.line_liff_id) {
            setDynamicLiffId(data.line_liff_id)
          }
          // The same settings response already carries the OA's basic ID — reused by the
          // Add Friend tab, no extra fetch. Missing/null leaves it empty (tab treats it as unset).
          setLineBasicId(data.line_basic_id || "")
        }
      } catch (err) {
        console.error("Failed to fetch settings for LIFF ID:", err)
      }
    }
    fetchSettings()
  }, [])

  const showNotification = (type: 'success' | 'warning' | 'error', text: string) => {
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
        showNotification('error', 'โหลดคำขอรออนุมัติไม่สำเร็จ')
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
        showNotification('error', 'โหลดรายการที่ผูกบัญชีแล้วไม่สำเร็จ')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'pending') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- tab/filter-driven load into state is the purpose of this effect (032)
      fetchPendingBindings()
    } else {
      fetchApprovedBindings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the two fetchers are re-created on every render, so adding them would re-run this effect continuously (032)
  }, [activeTab, search, sortKey, sortOrder, currentPage, itemsPerPage])

  // Debounced search for system users to pair
  useEffect(() => {
    if (!showPairModal) return
    if (!searchUserQuery.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale search results before the debounce fires is deliberate (032)
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
      const empName = matchedUser?.full_name || b.employee_name || b.core_employee_name || ''
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
        // The approve endpoint reports the real push outcome (task 005). A non-friend recipient
        // is silently dropped by LINE, so the admin must be told instead of being shown a plain
        // success toast. A missing/unknown value stays a neutral success.
        let pushStatus: string | null = null
        try {
          const data = await res.json()
          pushStatus = typeof data?.push_status === 'string' ? data.push_status : null
        } catch {
          // Unparsable body — the approval itself already succeeded, so do not fail the flow.
        }

        if (pushStatus === 'skipped_not_friend') {
          showNotification('warning', 'อนุมัติสำเร็จ แต่ยังไม่ได้ส่งข้อความต้อนรับ เพราะพนักงานยังไม่ได้เพิ่มเพื่อน LINE OA')
        } else if (pushStatus === 'skipped_no_token') {
          showNotification('warning', 'อนุมัติสำเร็จ แต่ยังไม่ได้ส่งข้อความต้อนรับ เพราะยังไม่ได้ตั้งค่า Channel Access Token ของ LINE OA')
        } else if (pushStatus === 'failed') {
          showNotification('warning', 'อนุมัติสำเร็จ แต่ส่งข้อความต้อนรับไม่สำเร็จ (LINE API ขัดข้อง)')
        } else {
          showNotification('success', 'อนุมัติสำเร็จ')
        }
        // Remove repaired state
        setRepairedUsers(prev => {
          const updated = { ...prev }
          delete updated[id]
          return updated
        })
        fetchPendingBindings()
      } else {
        const errData = await res.json()
        showNotification('error', errData.detail || 'อนุมัติไม่สำเร็จ')
      }
    } catch (err) {
      showNotification('error', permissionErrorMessage(err, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'))
    } finally {
      setProcessing(null)
    }
  }

  const handleReject = async (id: string) => {
    if (!confirm('ต้องการไม่อนุมัติคำขอนี้ใช่หรือไม่?')) return
    setProcessing(id)
    try {
      const res = await apiFetch(`${API_URL}/api/v1/line/reject/${id}`, {
        method: 'POST',
      })
      if (res.ok) {
        showNotification('success', 'ไม่อนุมัติคำขอแล้ว')
        fetchPendingBindings()
      } else {
        const errData = await res.json()
        showNotification('error', errData.detail || 'ไม่อนุมัติไม่สำเร็จ')
      }
    } catch (err) {
      showNotification('error', permissionErrorMessage(err, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'))
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
        showNotification('success', 'ยกเลิกการผูกบัญชีแล้ว')
        setShowRevokeModal(false)
        setRevokeReason("")
        setRevokingBinding(null)
        fetchApprovedBindings()
      } else {
        const errData = await res.json()
        showNotification('error', errData.detail || 'ยกเลิกการผูกบัญชีไม่สำเร็จ')
      }
    } catch (err) {
      showNotification('error', permissionErrorMessage(err, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'))
    } finally {
      setSubmittingRevoke(false)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- binding row from the list above; API shape, not modelled in the frontend yet (032)
  const openPairModal = (binding: any) => {
    setPairingBinding(binding)
    setSearchUserQuery("")
    setUserResults([])
    setShowPairModal(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- local-user search result; API shape, not modelled in the frontend yet (032)
  const selectPairUser = (user: any) => {
    if (!pairingBinding) return
    setRepairedUsers(prev => ({
      ...prev,
      [pairingBinding.id]: user
    }))
    setShowPairModal(false)
    setPairingBinding(null)
    showNotification('success', `จับคู่กับ ${user.full_name} (${user.employee_id}) แล้ว`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- binding row from the list above; API shape, not modelled in the frontend yet (032)
  const openRevokeModal = (binding: any) => {
    setRevokingBinding(binding)
    setRevokeReason("")
    setShowRevokeModal(true)
  }

  // Only the setter is used (the 2 s reset below); the value itself is never read, so the hole
  // takes it out of the lint report without dropping the state update it drives.
  const [, setCopied] = useState(false)
  const liffId = dynamicLiffId || process.env.NEXT_PUBLIC_LIFF_ID || ""
  const liffUrl = `https://liff.line.me/${liffId}`
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(liffUrl)}`

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(liffUrl)
      setCopied(true)
      showNotification('success', 'คัดลอกลิงก์แล้ว')
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn("Clipboard write failed for the LIFF registration link:", err)
      showNotification('error', 'คัดลอกไม่สำเร็จ กรุณาคัดลอกลิงก์ด้วยตนเอง')
    }
  }

  // --- Add Friend tab (static OA QR image) -------------------------------------------
  // The URL is built from the stored value exactly as the LIFF page's friendship-gate screen
  // does it (it interpolates `line_basic_id` as-is: no `@` added, no `@` stripped).
  const addFriendQrSrc = "/line/oa-add-friend-qr.png"
  const addFriendUrl = `https://line.me/R/ti/p/${lineBasicId}`
  const hasBasicId = lineBasicId.trim().length > 0

  const handleCopyAddFriendLink = async () => {
    try {
      await navigator.clipboard.writeText(addFriendUrl)
      showNotification('success', 'คัดลอกแล้ว')
    } catch (err) {
      console.warn("Clipboard write failed for the Add Friend link:", err)
      showNotification('error', 'คัดลอกไม่สำเร็จ กรุณาคัดลอกลิงก์ด้วยตนเอง')
    }
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
            : alertMsg.type === 'warning'
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
              : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
        )}>
          {alertMsg.type === 'success' ? <ShieldCheck size={20} /> : alertMsg.type === 'warning' ? <AlertTriangle size={20} /> : <ShieldAlert size={20} />}
          <span className="text-sm font-bold">{alertMsg.text}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
            <MessageSquare className="text-[#06C755]" /> ผูกบัญชี LINE
          </h1>
          <p className="text-sm font-bold text-base-content/50">ตรวจสอบ จับคู่ อนุมัติ และจัดการคำขอผูกบัญชี LINE</p>
        </div>
        {(activeTab === 'pending' || activeTab === 'approved') && (
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
          onClick={() => setActiveTab('addfriend')}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-tight border-b-2 transition-all cursor-pointer flex items-center gap-2",
            activeTab === 'addfriend'
              ? "border-primary text-primary"
              : "border-transparent text-base-content/50 hover:text-base-content"
          )}
        >
          <UserPlus size={16} /> เพิ่มเพื่อน
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
          <Clock size={16} /> รออนุมัติ
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
          <UserCheck size={16} /> ผูกบัญชีแล้ว
          {approvedTotal > 0 && (
            <span className="ml-1 bg-primary text-primary-content text-[10px] font-black px-2 py-0.5 rounded-full">
              {approvedTotal}
            </span>
          )}
        </button>
      </div>

      {/* Employee Rich Menu card (task 025) — Thai on purpose, see the state block above */}
      <div className="bg-base-100 rounded-3xl border border-base-300 shadow-sm p-6 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-2xl bg-primary/10 text-primary shrink-0">
              <LayoutGrid size={20} />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight text-base-content">เมนูพนักงาน</h2>
              <p className="text-xs text-base-content/50 mt-0.5">
                เมนูด้านล่างหน้าจอแชท LINE OA ที่พนักงานที่ผูกบัญชีแล้วเห็น ทั้ง 4 ปุ่มใช้งานได้แล้ว
                (ลงเวลา · รอบของฉัน · ประวัติการลงเวลา · ศูนย์รวมบริการ)
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {menuLoading ? (
              <span className="text-sm font-bold text-base-content/50 flex items-center gap-2">
                <Loader2 size={16} className="animate-spin text-primary" /> กำลังอ่านสถานะ...
              </span>
            ) : (
              <span
                className={cn(
                  "text-sm font-black px-3 py-1.5 rounded-xl border",
                  menuStatus?.menu_exists
                    ? "bg-success/10 text-success border-success/20"
                    : "bg-base-200 text-base-content/60 border-base-300"
                )}
              >
                {menuStatus?.menu_exists
                  ? `มีเมนูแล้ว (รหัส …${menuStatus?.menu_id_suffix ?? ''})`
                  : 'ยังไม่ได้สร้าง'}
              </span>
            )}
            <span className="text-sm font-bold text-base-content/70">
              พนักงานที่ผูกบัญชีแล้ว {menuStatus?.approved_bindings ?? 0} คน
            </span>
          </div>
        </div>

        <p className="text-xs text-base-content/50">
          พนักงานที่ผูกบัญชีแล้วเท่านั้นที่จะเห็นเมนู · การกดปุ่มด้านล่างจะสร้างเมนูใหม่บน LINE OA จริง
          และเชื่อมให้พนักงานทุกคนที่ผูกบัญชีแล้ว (เมนูเดิมจะถูกลบเมื่อเมนูใหม่พร้อมแล้ว)
        </p>

        {/* The error is a Thai sentence followed by LINE's own explanation when LINE sent one. That
            explanation arrives on its own line and can contain a long unbroken token such as
            `areas[0].action.uri`, so it has to wrap (whitespace-pre-line + break-words) instead of
            pushing the card sideways at 375 px. */}
        {menuError ? (
          <p className="text-xs font-bold text-error bg-error/10 border border-error/20 rounded-2xl px-4 py-3 whitespace-pre-line break-words">
            {menuError}
          </p>
        ) : menuStatus?.note_th ? (
          <p className="text-xs text-base-content/40">{menuStatus.note_th}</p>
        ) : null}

        {menuResult && (
          <div className="text-sm font-bold text-base-content bg-success/10 border border-success/20 rounded-2xl px-4 py-3">
            สร้างเมนูเรียบร้อย · เชื่อมสำเร็จ {menuResult.linked} คน
            {menuResult.failed > 0 && ` · ไม่สำเร็จ ${menuResult.failed} คน`}
            {menuResult.skipped > 0 && ` · ข้ามรายการซ้ำ ${menuResult.skipped} รายการ`}
            {menuResult.failed > 0 && ' — กดปุ่มอีกครั้งเพื่อเชื่อมรายที่ไม่สำเร็จซ้ำได้'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              setMenuError("")
              setMenuResult(null)
              setShowMenuConfirm(true)
            }}
            disabled={menuRunning || menuLoading || !menuStatus?.channel_token_configured || !menuStatus?.liff_id_configured}
            className="px-5 py-2.5 bg-primary text-primary-content rounded-2xl font-bold text-sm hover:opacity-90 transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
          >
            {menuRunning ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {menuRunning ? 'กำลังสร้างเมนู...' : 'สร้าง/อัปเดตเมนูและเชื่อมกับพนักงาน'}
          </button>
          <button
            onClick={fetchMenuStatus}
            disabled={menuLoading}
            className="px-4 py-2.5 bg-base-200 text-base-content/70 rounded-2xl font-bold text-sm hover:bg-base-300 transition-colors disabled:opacity-40 cursor-pointer"
          >
            ตรวจสอบสถานะ
          </button>
          {!menuStatus?.channel_token_configured && !menuLoading && (
            <span className="text-xs font-bold text-warning">ยังไม่ได้ตั้งค่า Channel Access Token ของ LINE</span>
          )}
          {menuStatus?.channel_token_configured && !menuStatus?.liff_id_configured && !menuLoading && (
            <span className="text-xs font-bold text-warning">ยังไม่ได้ตั้งค่า LIFF ID</span>
          )}
        </div>
      </div>

      {/* QR Code Tab */}
      {activeTab === 'qrcode' && (
        <div className="bg-base-100 p-8 rounded-3xl border border-base-300 shadow-sm flex flex-col md:flex-row gap-8 items-center md:items-start max-w-5xl mx-auto">
          {/* Left Side of Tab: QR Code display */}
          <div className="flex flex-col items-center justify-center p-6 bg-base-200/30 rounded-2xl border border-base-300/40 relative group shrink-0 w-full md:w-auto">
            <div className="p-3 bg-white rounded-2xl shadow-md border border-base-300/50">
              {/* eslint-disable-next-line @next/next/no-img-element -- QR image is generated remotely by api.qrserver.com; next/image would need a new remotePatterns entry (eslint.config.mjs is out of scope for 032) */}
              <img 
                src={qrCodeUrl} 
                alt="QR Code สำหรับลงทะเบียนพนักงาน" 
                className="w-56 h-56 block"
              />
            </div>
            
            <span className="mt-4 px-3 py-1 bg-[#06C755]/10 text-[#06C755] text-[10px] font-black rounded-full flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#06C755] animate-pulse"></span>
              เพิ่มเพื่อนอัตโนมัติ
            </span>
          </div>

          {/* Right Side of Tab: URL, Copy Button, Onboarding guide */}
          <div className="flex-1 space-y-6 w-full">
            <div className="flex items-center gap-3 border-b border-base-200 pb-4">
              <div className="w-10 h-10 rounded-2xl bg-[#06C755]/10 flex items-center justify-center text-[#06C755] shrink-0">
                <QrCode size={22} />
              </div>
              <div>
                <h3 className="font-black text-lg text-base-content leading-tight">ลงทะเบียนพนักงาน</h3>
                <p className="text-xs text-base-content/40 mt-0.5">สแกน QR แล้วกรอกรหัสพนักงาน</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-base-content/40 font-bold block">ลิงก์ LIFF</label>
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
                  title="คัดลอกลิงก์"
                >
                  <Copy size={16} />
                </button>
              </div>
            </div>

            <div className="bg-base-200/50 p-6 rounded-2xl border border-base-300/50 text-xs text-base-content/60 space-y-3 leading-relaxed">
              <h4 className="font-bold text-sm text-base-content/80 flex items-center gap-1.5">
                💡 ขั้นตอนการลงทะเบียน
              </h4>
              <p className="text-[12px]">
                1. ให้พนักงานสแกน QR นี้จากหน้าจอ หรือเปิดลิงก์ LIFF
              </p>
              <p className="text-[12px]">
                2. เมื่อเพิ่มเพื่อนแล้ว แอป LINE จะเปิดหน้าลงทะเบียนให้อัตโนมัติ
              </p>
              <p className="text-[12px]">
                3. พนักงานกรอกรหัสพนักงานของตัวเองแล้วกดส่ง
              </p>
              <p className="text-[12px]">
                4. กลับมาอนุมัติคำขอของพนักงานในหน้านี้
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Add Friend Tab — static add-friend QR of this project's OA (see docs/LINE_SETUP_GUIDE.md) */}
      {activeTab === 'addfriend' && (
        <div className="bg-base-100 p-8 rounded-3xl border border-base-300 shadow-sm flex flex-col md:flex-row gap-8 items-center md:items-start max-w-5xl mx-auto">
          {/* Left Side: the QR image + download */}
          <div className="flex flex-col items-center justify-center p-6 bg-base-200/30 rounded-2xl border border-base-300/40 shrink-0 w-full md:w-auto min-w-0">
            <div className="p-3 bg-white rounded-2xl shadow-md border border-base-300/50">
              {/* `unoptimized` is deliberate: this project's auth middleware (src/proxy.ts) gates every
                  path except api/_next/favicon.ico, and the image optimizer re-fetches the local public
                  file itself — with no cookie — so it receives the login page and answers
                  400 "The requested resource isn't a valid image." (broken image). Skipping the
                  optimizer makes the browser fetch the file directly, exactly like the QR tab's <img>. */}
              <Image
                src={addFriendQrSrc}
                alt="QR code สำหรับเพิ่มเพื่อน LINE Official Account"
                width={224}
                height={224}
                unoptimized
                className="w-56 h-56 max-w-full block"
              />
            </div>

            <a
              href={addFriendQrSrc}
              download="oa-add-friend-qr.png"
              className="mt-4 px-4 py-2 bg-base-200 hover:bg-base-300 text-base-content/70 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 active:scale-95"
            >
              <Download size={14} /> ดาวน์โหลดรูป
            </a>
          </div>

          {/* Right Side: ID, links and instructions */}
          <div className="flex-1 space-y-6 w-full min-w-0">
            <div className="flex items-center gap-3 border-b border-base-200 pb-4">
              <div className="w-10 h-10 rounded-2xl bg-[#06C755]/10 flex items-center justify-center text-[#06C755] shrink-0">
                <UserPlus size={22} />
              </div>
              <div>
                <h3 className="font-black text-lg text-base-content leading-tight">เพิ่มเพื่อน LINE OA</h3>
                <p className="text-xs text-base-content/40 mt-0.5">เพิ่มเพื่อน OA ก่อนลงทะเบียน</p>
              </div>
            </div>

            {hasBasicId ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] text-base-content/40 font-bold block">ไอดี LINE OA</label>
                  <input
                    type="text"
                    value={lineBasicId}
                    readOnly
                    className="w-full bg-base-200 border border-base-300/50 rounded-xl px-4 py-3 text-xs font-mono text-base-content/60 outline-none select-all"
                  />
                </div>
                <div className="flex flex-wrap gap-3">
                  <a
                    href={addFriendUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2.5 bg-[#06C755] hover:bg-[#05a848] text-white text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 active:scale-95"
                  >
                    <Link size={14} /> เปิดใน LINE
                  </a>
                  <button
                    onClick={handleCopyAddFriendLink}
                    className="px-4 py-2.5 bg-primary/10 text-primary hover:bg-primary hover:text-primary-content text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 active:scale-95"
                  >
                    <Copy size={14} /> คัดลอกลิงก์
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-base-content/50 bg-base-200/60 border border-base-300/50 rounded-xl px-4 py-3">
                ยังไม่ได้ตั้งค่า LINE Basic ID ใน Settings
              </p>
            )}

            <div className="bg-base-200/50 p-6 rounded-2xl border border-base-300/50 text-xs text-base-content/60 space-y-3 leading-relaxed">
              <h4 className="font-bold text-sm text-base-content/80 flex items-center gap-1.5">
                💡 วิธีใช้
              </h4>
              <p className="text-[12px]">
                1. ให้พนักงานสแกน QR นี้ (หรือกดปุ่ม &quot;เปิดใน LINE&quot;) เพื่อเพิ่ม OA เป็นเพื่อนก่อน
              </p>
              <p className="text-[12px]">
                2. จากนั้นสแกน QR ลงทะเบียนในแท็บ &quot;LIFF QR Code&quot; เพื่อผูกบัญชีพนักงาน
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
                placeholder="ค้นหารหัสพนักงาน ชื่อ หรือ LINE ID" 
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
                <span className="text-sm text-base-content/40 font-bold">กำลังค้นหาคำขอ...</span>
              </div>
            ) : filteredPendingBindings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 bg-base-100 rounded-2xl border border-dashed border-base-300">
                <div className="w-16 h-16 bg-base-200 rounded-full flex items-center justify-center mb-4">
                  <Check className="text-base-content/20" size={32} />
                </div>
                <span className="text-sm text-base-content/40 font-bold">ไม่มีคำขอรออนุมัติ</span>
                <p className="text-xs text-base-content/30 mt-1">ตอนนี้ไม่มีคำขอผูกบัญชีที่รอการอนุมัติ</p>
              </div>
            ) : (
              filteredPendingBindings.map((item) => {
                const repairedUser = repairedUsers[item.id]
                const finalEmpId = repairedUser?.employee_id || item.employee_id
                const finalEmpName = repairedUser?.full_name || item.employee_name || item.core_employee_name
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
                          <span className="font-black text-lg tracking-tight">พนักงาน: {finalEmpName || 'ยังไม่จับคู่'}</span>
                          {item.core_lookup === 'not_found' && (
                            <span className="px-2 py-0.5 bg-red-500/10 text-red-600 dark:text-red-400 text-[10px] font-black rounded-full">
                              ไม่พบรหัสนี้ใน Core-API
                            </span>
                          )}
                          {item.core_lookup === 'unavailable' && (
                            <span className="px-2 py-0.5 bg-base-200 text-base-content/60 text-[10px] font-black rounded-full">
                              ตรวจกับ Core-API ไม่ได้ชั่วคราว
                            </span>
                          )}
                          <span className="px-2.5 py-0.5 bg-base-200 text-base-content/60 text-[10px] font-black rounded-full">
                            ID: {finalEmpId}
                          </span>
                          {isRepaired && (
                            <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] font-black rounded-full">
                              จับคู่ใหม่แล้ว
                            </span>
                          )}
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/50">
                          <div className="font-mono text-[11px] bg-base-200 px-2 py-0.5 rounded text-base-content/70">
                             LINE ID: {item.line_user_id}
                          </div>
                          {finalDept && (
                            <>
                              <div className="w-1.5 h-1.5 bg-base-content/20 rounded-full hidden sm:block"></div>
                              <div>แผนก: {finalDept} {item.company ? `(${item.company})` : ''}</div>
                            </>
                          )}
                          <div className="w-1.5 h-1.5 bg-base-content/20 rounded-full hidden sm:block"></div>
                          <div>วันที่ขอ: {formatThaiDateTime(item.created_at)}</div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button 
                         onClick={() => openPairModal(item)}
                         disabled={!!processing}
                         className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl border border-primary/20 text-primary font-bold text-xs hover:bg-primary/5 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                      >
                        จับคู่พนักงาน
                      </button>
                      <button 
                         onClick={() => handleReject(item.id)}
                         disabled={!!processing}
                         className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl border border-error/20 text-error font-bold text-xs hover:bg-error hover:text-error-content transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                      >
                        ไม่อนุมัติ
                      </button>
                      <button 
                         onClick={() => handleApprove(item.id)}
                         disabled={!!processing}
                         className="flex-1 sm:flex-none px-5 py-2.5 rounded-xl bg-success text-success-content font-bold text-xs hover:opacity-90 shadow-lg shadow-success/20 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        {processing === item.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        อนุมัติ
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
                placeholder="ค้นหาชื่อ รหัสพนักงาน แผนก หรือ LINE ID" 
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
                <span className="text-xs text-base-content/40">เรียงตาม</span>
                <select
                  value={sortKey}
                  onChange={(e) => {
                    setSortKey(e.target.value as 'created_at' | 'employee_id' | 'approved_at')
                    setCurrentPage(1)
                  }}
                  className="bg-base-200 border-none rounded-lg px-2.5 py-1.5 outline-none font-bold text-xs cursor-pointer"
                >
                  <option value="created_at">วันที่ขอ</option>
                  <option value="approved_at">วันที่อนุมัติ</option>
                  <option value="employee_id">รหัสพนักงาน</option>
                </select>
              </div>
              
              <button
                onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                className="p-2.5 hover:bg-base-200 rounded-lg text-base-content/50 transition-colors cursor-pointer flex items-center justify-center"
                title={sortOrder === 'asc' ? 'เรียงจากมากไปน้อย' : 'เรียงจากน้อยไปมาก'}
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
                  <tr className="bg-base-200/50 border-b border-base-300 text-xs font-bold text-base-content/50">
                    <th className="px-6 py-4">พนักงาน</th>
                    <th className="px-6 py-4">LINE ID</th>
                    <th className="px-6 py-4">แผนก</th>
                    <th className="px-6 py-4">อนุมัติโดย / เมื่อ</th>
                    <th className="px-6 py-4 text-right">จัดการ</th>
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
                        ไม่พบรายการที่ผูกบัญชีแล้ว
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
                              <div className="font-bold text-sm text-base-content">{u.employee_name || 'ไม่ระบุ'}</div>
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
                          <div className="text-xs text-base-content/80">โดย: {u.approved_by || 'ระบบ'}</div>
                          <div className="text-[10px] text-base-content/40">
                            {u.approved_at ? formatThaiDateTime(u.approved_at) : '-'}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => openRevokeModal(u)}
                            aria-label={`ยกเลิกการผูกบัญชีของ ${u.employee_name || u.employee_id}`}
                            className="px-3.5 py-1.5 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 text-xs font-bold rounded-xl transition-all cursor-pointer inline-flex items-center gap-1.5 active:scale-95"
                          >
                            <UserX size={14} /> ยกเลิกการผูกบัญชี
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
                  แสดง {Math.min((currentPage - 1) * itemsPerPage + 1, approvedTotal)}–{Math.min(currentPage * itemsPerPage, approvedTotal)} จาก {approvedTotal} รายการ
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
                      ถัดไป
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm dialog for publishing the employee rich menu (task 025) */}
      {showMenuConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-base-100 rounded-3xl border border-base-300 w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-base-300 flex justify-between items-center bg-base-200/50">
              <h2 className="text-lg font-black tracking-tight text-base-content flex items-center gap-2">
                <LayoutGrid className="text-primary" size={20} /> ยืนยันการสร้างเมนูพนักงาน
              </h2>
              <button
                onClick={() => setShowMenuConfirm(false)}
                className="p-2 hover:bg-base-300 rounded-xl text-base-content/40 hover:text-base-content transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-base-content">
                ระบบจะสร้างเมนูใหม่บน LINE OA จริง และเชื่อมเมนูให้พนักงานที่ผูกบัญชีแล้ว{' '}
                <span className="font-black text-primary">{menuStatus?.approved_bindings ?? 0} คน</span>
              </p>
              <ul className="text-xs text-base-content/60 space-y-1.5 list-disc pl-5">
                <li>เมนูเดิม (ชื่อเดียวกัน) จะถูกลบหลังเมนูใหม่พร้อมใช้งาน</li>
                <li>พนักงานที่ยังไม่ได้ผูกบัญชีจะไม่เห็นเมนูนี้</li>
                <li>ใช้เวลาสักครู่ และไม่กระทบการลงเวลาของพนักงาน</li>
              </ul>
              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                <button
                  onClick={publishMenu}
                  className="flex-1 px-5 py-2.5 bg-primary text-primary-content rounded-2xl font-bold text-sm hover:opacity-90 transition-all active:scale-98 cursor-pointer"
                >
                  ยืนยัน สร้าง/อัปเดตเมนู
                </button>
                <button
                  onClick={() => setShowMenuConfirm(false)}
                  className="flex-1 px-5 py-2.5 bg-base-200 text-base-content/70 rounded-2xl font-bold text-sm hover:bg-base-300 transition-colors cursor-pointer"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
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
                  <Link className="text-primary" size={20} /> จับคู่คำขอกับพนักงาน
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">เลือกผู้ใช้งานในระบบเพื่อผูกกับบัญชี LINE นี้</p>
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
                <span className="font-mono text-base-content/50">LINE ID: {pairingBinding.line_user_id}</span>
                <span className="font-bold text-base-content/70">รหัสพนักงานที่ส่งคำขอ: {pairingBinding.employee_id}</span>
              </div>
              
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" size={18} />
                <input 
                  type="text" 
                  placeholder="ค้นหาชื่อหรือรหัสพนักงาน" 
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
                    <Loader2 size={16} className="animate-spin text-primary" /> กำลังค้นหา...
                  </div>
                ) : userResults.length === 0 ? (
                  <div className="text-center py-10 text-xs text-base-content/40 italic">
                    {searchUserQuery ? 'ไม่พบผู้ใช้งานที่ตรงกับคำค้น' : 'พิมพ์เพื่อค้นหาพนักงาน'}
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
                        เลือก
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
                  <UserX className="text-red-500" size={20} /> ยกเลิกการผูกบัญชี LINE
                </h2>
                <p className="text-xs text-base-content/50 mt-0.5">กรุณาระบุเหตุผลที่ยกเลิกการผูกบัญชีนี้</p>
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
                  <h4 className="font-bold">คำเตือน: จะยกเลิกการเข้าถึง</h4>
                  <p className="mt-0.5 opacity-90">ยกเลิกแล้วพนักงาน <strong>{revokingBinding.employee_name} ({revokingBinding.employee_id})</strong> จะไม่ได้รับการแจ้งเตือนผ่าน LINE บัญชีนี้</p>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-base-content/50">เหตุผลที่ยกเลิก</label>
                <textarea 
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  placeholder="เช่น พนักงานขอเปลี่ยนเครื่อง ทำมือถือหาย ลาออก"
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
                ยกเลิก
              </button>
              <button
                onClick={handleRevokeSubmit}
                disabled={submittingRevoke || !revokeReason.trim()}
                className="px-5 py-2.5 bg-red-600 text-white hover:bg-red-700 font-bold text-xs rounded-xl shadow-lg shadow-red-500/20 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {submittingRevoke ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />}
                ยืนยันยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Security Info Card */}
      <div className="bg-warning/10 p-5 rounded-3xl border border-warning/20 flex items-start gap-4">
        <ShieldAlert className="text-warning mt-0.5 shrink-0" size={22} />
        <div>
          <h4 className="text-sm font-black text-base-content">ข้อกำหนดการผูกบัญชีของระบบ</h4>
          <p className="text-xs text-base-content/70 mt-1 leading-relaxed">
            - <strong>1 LINE ต่อ 1 พนักงาน:</strong> เมื่ออนุมัติการผูกบัญชีใหม่ ระบบจะยกเลิกการผูกบัญชีเดิมของพนักงานคนนั้นให้อัตโนมัติ<br />
            - <strong>1 พนักงาน ต่อ 1 LINE:</strong> บัญชี LINE หนึ่งบัญชีผูกกับพนักงานหลายคนพร้อมกันไม่ได้ ถ้าพบ LINE ID ซ้ำ ระบบจะไม่อนุมัติให้<br />
            - <strong>บันทึกการใช้งาน:</strong> การอนุมัติและการยกเลิกทุกครั้งจะถูกบันทึกไว้ และดูได้ที่เมนู บันทึกการใช้งาน
          </p>
        </div>
      </div>
    </div>
  )
}
