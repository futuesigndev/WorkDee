"use client"

import React, { useState, useEffect, useCallback } from 'react'
import { 
  History, 
  Search, 
  Filter,
  Terminal,
  User,
  Activity,
  Calendar,
  RefreshCw,
  Clock,
  BarChart3,
  Users,
  Shield,
  ArrowUpDown
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatThaiDate, formatThaiTime } from '@/lib/datetime'

/**
 * An audit timestamp as the instant it really is (task 047 / 046b).
 *
 * `audit_logs.created_at` is a `timestamp without time zone` written by `datetime.utcnow`, so the API
 * serialises it **without an offset** — and `new Date("2026-09-29T08:56:42")` reads a string without
 * an offset as *local* time. The page therefore printed the UTC clock: the phone check-in of
 * 2026-09-29 15:56 Bangkok showed as 08:56. Marking the value as UTC restores it (measured against
 * `attendance_checkins.checked_at`, which is a real timestamptz for the very same event). A value that
 * already carries `Z` or an offset is passed through untouched, so this cannot shift anything else.
 */
function auditInstant(value: string | null | undefined): string | null {
  if (!value) return null
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return value
  // Python writes microseconds (6 fraction digits); Date only guarantees 3, so trim the rest.
  return `${value.replace(/(\.\d{3})\d+$/, "$1")}Z`
}
import { API_URL, apiFetch } from '@/lib/api'
import { isPermissionDenied } from '@/lib/errors'
import AccessDenied from '@/components/AccessDenied'

// Helper for formatting duration
const formatDuration = (minutes: number) => {
  if (!minutes || isNaN(minutes) || minutes < 0) return "0m"
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

export default function LogsPage() {
  // Date Range Defaults (Last 30 Days)
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().split('T')[0]
  })
  const [dateTo, setDateTo] = useState(() => {
    return new Date().toISOString().split('T')[0]
  })

  // Filter States
  const [actorFilter, setActorFilter] = useState("")
  const [actionFilter, setActionFilter] = useState("ALL")
  const [sessionGroupBy, setSessionGroupBy] = useState<"month" | "day">("month")

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'ascending' | 'descending' } | null>(null)

  // Data States
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- audit-log rows are the API's shape and have no frontend type yet; typing them is a design task (032)
  const [logs, setLogs] = useState<any[]>([])
  const [totalLogs, setTotalLogs] = useState(0)
  const [loadingLogs, setLoadingLogs] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- summary payload is the API's shape, not modelled in the frontend yet (032)
  const [summary, setSummary] = useState<any>({
    total_logins_today: 0,
    unique_users_today: 0,
    total_logins_period: 0,
    top_users: []
  })
  const [loadingSummary, setLoadingSummary] = useState(true)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- session rows are the API's shape and have no frontend type yet (032)
  const [sessions, setSessions] = useState<any[]>([])
  const [loadingSessions, setLoadingSessions] = useState(true)

  // Fetch functions
  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true)
    try {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        page_size: itemsPerPage.toString(),
        action_filter: actionFilter,
        actor_filter: actorFilter,
        date_from: dateFrom,
        date_to: dateTo
      })
      const res = await apiFetch(`${API_URL}/api/v1/logs?${params.toString()}`)
      if (res.ok) {
        const data = await res.json()
        // If paginated response
        if (data && data.logs) {
          setLogs(data.logs)
          setTotalLogs(data.total)
        } else {
          setLogs(data)
          setTotalLogs(data.length)
        }
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error("Error fetching logs:", err)
    } finally {
      setLoadingLogs(false)
    }
  }, [currentPage, itemsPerPage, actionFilter, actorFilter, dateFrom, dateTo])

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true)
    try {
      const params = new URLSearchParams({
        date_from: dateFrom,
        date_to: dateTo
      })
      const res = await apiFetch(`${API_URL}/api/v1/logs/summary?${params.toString()}`)
      if (res.ok) {
        setSummary(await res.json())
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error("Error fetching summary:", err)
    } finally {
      setLoadingSummary(false)
    }
  }, [dateFrom, dateTo])

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const params = new URLSearchParams({
        group_by: sessionGroupBy,
        actor_filter: actorFilter,
        date_from: dateFrom,
        date_to: dateTo
      })
      const res = await apiFetch(`${API_URL}/api/v1/logs/sessions?${params.toString()}`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions || [])
      }
    } catch (err) {
      if (isPermissionDenied(err)) setAccessDenied(true)
      else console.error("Error fetching sessions:", err)
    } finally {
      setLoadingSessions(false)
    }
  }, [sessionGroupBy, actorFilter, dateFrom, dateTo])



  // Trigger fetches on filter change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading the result list into state on mount/filter change is the purpose of this effect (032)
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading the summary into state is the purpose of this effect (032)
    fetchSummary()
  }, [fetchSummary])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading the session list into state is the purpose of this effect (032)
    fetchSessions()
  }, [fetchSessions])

  const handleRefreshAll = () => {
    fetchLogs()
    fetchSummary()
    fetchSessions()
  }

  // Aggregate user sessions for the bar chart
  const userAggregates = React.useMemo(() => {
    const map: Record<string, { actor_id: string; full_name: string; total_minutes: number; session_count: number }> = {}
    sessions.forEach(s => {
      if (!map[s.actor_id]) {
        map[s.actor_id] = { actor_id: s.actor_id, full_name: s.full_name, total_minutes: 0, session_count: 0 }
      }
      map[s.actor_id].total_minutes += s.total_minutes
      map[s.actor_id].session_count += s.session_count
    })
    return Object.values(map).sort((a, b) => b.total_minutes - a.total_minutes)
  }, [sessions])

  const maxMinutes = React.useMemo(() => {
    const max = Math.max(...userAggregates.map(u => u.total_minutes), 60)
    return max
  }, [userAggregates])

  // Sorting handlers (local table sorting)
  const handleSort = (key: string) => {
    let direction: 'ascending' | 'descending' = 'ascending'
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending'
    }
    setSortConfig({ key, direction })
  }

  const sortedLogs = React.useMemo(() => {
    if (!sortConfig) return logs
    const sorted = [...logs]
    sorted.sort((a, b) => {
      let aVal = a[sortConfig.key] || ""
      let bVal = b[sortConfig.key] || ""

      if (sortConfig.key === 'created_at') {
        aVal = new Date(aVal).getTime()
        bVal = new Date(bVal).getTime()
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
    return sorted
  }, [logs, sortConfig])

  const getActionColor = (action: string) => {
    if (action === 'AUTH_LOGIN_SUCCESS') return 'text-emerald-500 bg-emerald-500/10 border border-emerald-500/20'
    if (action === 'AUTH_LOGOUT') return 'text-slate-400 bg-slate-400/10 border border-slate-400/20'
    if (action.includes('DEPROVISION') || action.includes('DELETE') || action.includes('FAIL')) {
      return 'text-rose-500 bg-rose-500/10 border border-rose-500/20'
    }
    if (action.includes('PROVISION') || action.includes('CREATE') || action.includes('ACTIVATED')) {
      return 'text-amber-500 bg-amber-500/10 border border-amber-500/20'
    }
    return 'text-sky-500 bg-sky-500/10 border border-sky-500/20'
  }

  const totalPages = Math.ceil(totalLogs / itemsPerPage)

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-8 pb-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
            <History className="text-primary" /> บันทึกการใช้งานและเซสชัน
          </h1>
          <p className="text-base-content/50 text-sm font-bold">ติดตามเหตุการณ์และระยะเวลาการใช้งาน</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRefreshAll} className="btn btn-ghost btn-sm text-base-content/50 hover:text-base-content gap-2">
            <RefreshCw size={16} className={cn((loadingLogs || loadingSummary || loadingSessions) && "animate-spin")} />
            รีเฟรช
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { 
            label: 'เข้าสู่ระบบวันนี้', 
            value: summary.total_logins_today, 
            subtitle: 'เข้าสู่ระบบสำเร็จ',
            icon: Shield, 
            color: 'text-emerald-500',
            loading: loadingSummary
          },
          { 
            label: 'ผู้ใช้งานวันนี้', 
            value: summary.unique_users_today, 
            subtitle: 'บัญชีที่ใช้งานไม่ซ้ำกัน',
            icon: Users, 
            color: 'text-indigo-500',
            loading: loadingSummary
          },
          { 
            label: 'เข้าสู่ระบบทั้งหมด', 
            value: summary.total_logins_period, 
            subtitle: 'ในช่วงวันที่ที่เลือก',
            icon: Activity, 
            color: 'text-primary',
            loading: loadingSummary
          },
          { 
            label: 'ผู้ใช้งานมากที่สุด', 
            value: summary.top_users && summary.top_users[0] ? summary.top_users[0].full_name : 'ไม่มีข้อมูล', 
            subtitle: summary.top_users && summary.top_users[0] ? `เข้าสู่ระบบ ${summary.top_users[0].login_count} ครั้งในช่วงนี้` : 'ไม่มีข้อมูลในช่วงนี้',
            icon: Clock, 
            color: 'text-amber-500',
            loading: loadingSummary
          },
        ].map((stat, i) => (
          <div key={i} className="bg-base-100 p-5 rounded-2xl border border-base-300 shadow-sm flex items-center justify-between transition-all hover:shadow-md">
            <div className="space-y-1">
              <span className="text-[10px] font-black text-base-content/30">{stat.label}</span>
              {stat.loading ? (
                <div className="h-8 bg-base-200 animate-pulse rounded w-16"></div>
              ) : (
                <div className="text-xl font-black truncate max-w-[180px]">{stat.value}</div>
              )}
              <span className="text-[10px] text-base-content/40 block leading-tight">{stat.subtitle}</span>
            </div>
            <div className={cn("p-3 rounded-xl bg-base-200/50", stat.color)}>
              <stat.icon size={22} />
            </div>
          </div>
        ))}
      </div>

      {/* Date & Filter controls */}
      <div className="bg-base-100 p-5 rounded-2xl border border-base-300 shadow-sm space-y-4">
        <h2 className="text-sm font-bold flex items-center gap-2"><Filter size={16} className="text-primary" /> ตัวกรองข้อมูล</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="text-[10px] font-black text-base-content/40 block mb-1.5">วันที่เริ่มต้น</label>
            <input 
              type="date" 
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setCurrentPage(1); }}
              className="input input-bordered input-sm w-full text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] font-black text-base-content/40 block mb-1.5">วันที่สิ้นสุด</label>
            <input 
              type="date" 
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setCurrentPage(1); }}
              className="input input-bordered input-sm w-full text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] font-black text-base-content/40 block mb-1.5">กรองตามผู้ใช้งาน</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/30" size={14} />
              <input 
                type="text" 
                placeholder="ค้นหาผู้ใช้งาน..." 
                value={actorFilter}
                onChange={(e) => { setActorFilter(e.target.value); setCurrentPage(1); }}
                className="input input-bordered input-sm w-full pl-8 text-xs"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black text-base-content/40 block mb-1.5">กรองตามการทำงาน</label>
            <select
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setCurrentPage(1); }}
              className="select select-bordered select-sm w-full text-xs font-bold"
            >
              <option value="ALL">ทุกการทำงาน</option>
              <option value="AUTH_LOGIN_SUCCESS">เข้าสู่ระบบสำเร็จ (AUTH_LOGIN_SUCCESS)</option>
              <option value="AUTH_LOGOUT">ออกจากระบบ (AUTH_LOGOUT)</option>
              <option value="USER_PROVISIONED">เพิ่มผู้ใช้งาน (USER_PROVISIONED)</option>
              <option value="USER_ACTIVATED">เปิดใช้งานผู้ใช้งาน (USER_ACTIVATED)</option>
              <option value="USER_DEPROVISIONED">ปิดใช้งานผู้ใช้งาน (USER_DEPROVISIONED)</option>
              {/* Task 046: this list is static, so every new action code has to be added here by hand
                  or the row it writes is only reachable through "ทุกการทำงาน" and never filterable. */}
              <option value="SETTINGS_UPDATED">แก้ไขการตั้งค่าระบบ (SETTINGS_UPDATED)</option>
              <option value="ROLE_CREATED">สร้างบทบาท (ROLE_CREATED)</option>
              <option value="ROLE_UPDATED">แก้ไขบทบาท (ROLE_UPDATED)</option>
              <option value="ROLE_PERMISSIONS_CHANGED">แก้ไขสิทธิ์เมนูของบทบาท (ROLE_PERMISSIONS_CHANGED)</option>
              <option value="ROLE_DELETED">ลบบทบาท (ROLE_DELETED)</option>
              <option value="MENU_CREATED">สร้างเมนู (MENU_CREATED)</option>
              <option value="MENU_UPDATED">แก้ไขเมนู (MENU_UPDATED)</option>
              <option value="MENU_DELETED">ลบเมนู (MENU_DELETED)</option>
              <option value="EVENT_LINE_BINDING_REJECTED">ไม่อนุมัติคำขอผูกบัญชี LINE (EVENT_LINE_BINDING_REJECTED)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Analytics: Chart and Monthly Summary Table */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* CSS Bar Chart */}
        <div className="lg:col-span-6 bg-base-100 p-5 rounded-2xl border border-base-300 shadow-sm flex flex-col justify-between min-h-[350px]">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-black flex items-center gap-1.5">
                  <BarChart3 className="text-primary" size={16} /> เวลาใช้งานรวมต่อผู้ใช้งาน
                </h3>
                <p className="text-[10px] text-base-content/40 leading-normal">รวมเวลาจากการจับคู่เข้า-ออกระบบในช่วงที่เลือก</p>
              </div>
              <span className="text-[10px] font-mono bg-base-200 px-2 py-0.5 rounded text-base-content/50">
                {userAggregates.length} คน
              </span>
            </div>

            {loadingSessions ? (
              <div className="h-56 flex items-center justify-center">
                <span className="loading loading-spinner loading-md text-primary"></span>
              </div>
            ) : userAggregates.length === 0 ? (
              <div className="h-56 flex flex-col items-center justify-center text-center">
                <span className="text-base-content/20 italic font-black text-xl mb-2">ไม่พบข้อมูลการใช้งาน</span>
                <span className="text-[10px] text-base-content/40 italic">ตรวจสอบว่าผู้ใช้งานมีกิจกรรมเข้าและออกจากระบบในช่วงเวลานี้</span>
              </div>
            ) : (
              <div className="h-56 flex items-end justify-around gap-2 px-2 border-b border-base-300 pb-2">
                {userAggregates.slice(0, 10).map((item, idx) => (
                  <div key={idx} className="flex flex-col items-center flex-1 max-w-[50px] group relative h-full justify-end">
                    
                    {/* Tooltip */}
                    <div className="absolute bottom-full mb-2 bg-neutral text-neutral-content text-[10px] p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-20 shadow-lg leading-normal">
                      <div className="font-bold">{item.full_name}</div>
                      <div className="text-primary-content">{formatDuration(item.total_minutes)}</div>
                      <div className="text-neutral-content/60">{item.session_count} ครั้ง</div>
                    </div>
                    
                    {/* Bar */}
                    <div 
                      className="w-full bg-gradient-to-t from-primary/70 to-primary rounded-t-lg transition-all duration-500 hover:from-primary hover:to-primary-focus cursor-pointer shadow-sm"
                      style={{ height: `${(item.total_minutes / maxMinutes) * 85 + 5}%` }}
                    />
                    
                    {/* Label */}
                    <div className="text-[9px] text-base-content/60 mt-1.5 font-mono truncate w-full text-center" title={item.actor_id}>
                      {item.actor_id}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="text-[9px] text-base-content/40 text-right mt-2 italic">
            * แสดง 10 ผู้ใช้งานที่ใช้งานมากที่สุด ชี้ที่แท่งกราฟเพื่อดูรายละเอียด
          </div>
        </div>

        {/* Monthly Summary Table */}
        <div className="lg:col-span-6 bg-base-100 p-5 rounded-2xl border border-base-300 shadow-sm flex flex-col justify-between min-h-[350px]">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-black flex items-center gap-1.5">
                  <Calendar className="text-indigo-500" size={16} /> สรุปเวลาใช้งาน
                </h3>
                <p className="text-[10px] text-base-content/40 leading-normal">รวมชั่วโมงทำงานต่อผู้ใช้งานและช่วงเวลา</p>
              </div>
              <div className="flex gap-1.5">
                <button 
                  onClick={() => setSessionGroupBy("month")}
                  className={cn("px-2 py-0.5 text-[9px] font-bold rounded transition-all", sessionGroupBy === 'month' ? "bg-indigo-500 text-white" : "bg-base-200 hover:bg-base-300 text-base-content/60")}
                >
                  เดือน
                </button>
                <button 
                  onClick={() => setSessionGroupBy("day")}
                  className={cn("px-2 py-0.5 text-[9px] font-bold rounded transition-all", sessionGroupBy === 'day' ? "bg-indigo-500 text-white" : "bg-base-200 hover:bg-base-300 text-base-content/60")}
                >
                  วัน
                </button>
              </div>
            </div>

            <div className="overflow-x-auto max-h-[220px]">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 bg-base-100 border-b border-base-300 text-[10px] font-black text-base-content/40">
                  <tr>
                    <th className="pb-2">ผู้ใช้งาน</th>
                    <th className="pb-2">ช่วงเวลา</th>
                    <th className="pb-2 text-center">จำนวนครั้ง</th>
                    <th className="pb-2 text-right">เวลารวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-200">
                  {loadingSessions ? (
                    [1, 2, 3].map(i => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={4} className="py-2.5"><div className="h-3.5 bg-base-200 rounded w-full"></div></td>
                      </tr>
                    ))
                  ) : sessions.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-10 text-center text-[10px] text-base-content/30 italic">
                        ไม่พบข้อมูลในช่วงนี้
                      </td>
                    </tr>
                  ) : (
                    sessions.slice(0, 50).map((s, idx) => (
                      <tr key={idx} className="hover:bg-base-200/20">
                        <td className="py-2">
                          <div className="font-bold leading-tight">{s.full_name}</div>
                          <div className="text-[9px] text-base-content/40 font-mono">{s.actor_id}</div>
                        </td>
                        <td className="py-2 font-mono text-[10px] text-base-content/60">{s.period}</td>
                        <td className="py-2 text-center font-bold">{s.session_count}</td>
                        <td className="py-2 text-right font-mono font-bold text-indigo-500">
                          {formatDuration(s.total_minutes)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="text-[9px] text-base-content/30 italic mt-3">
            * ระบบจับคู่เข้า-ออกระบบให้อัตโนมัติ หากไม่มีการออกจากระบบ จะนับให้ไม่เกิน 8 ชั่วโมง
          </div>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-base-100 rounded-2xl border border-base-300 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-base-300 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black flex items-center gap-1.5">
              <Terminal className="text-warning" size={16} /> บันทึกเหตุการณ์
            </h3>
            <p className="text-[10px] text-base-content/40 leading-normal">รายการบันทึกตามลำดับเวลา</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-base-200/40 border-b border-base-300 text-[10px] font-black text-base-content/40">
              <tr>
                <th className="px-6 py-4 cursor-pointer select-none hover:text-base-content transition-colors" onClick={() => handleSort('created_at')}>
                  <div className="flex items-center gap-1">
                    วันเวลา <ArrowUpDown size={12} />
                  </div>
                </th>
                <th className="px-6 py-4 cursor-pointer select-none hover:text-base-content transition-colors" onClick={() => handleSort('action')}>
                  <div className="flex items-center gap-1">
                    การทำงาน <ArrowUpDown size={12} />
                  </div>
                </th>
                <th className="px-6 py-4 cursor-pointer select-none hover:text-base-content transition-colors" onClick={() => handleSort('actor_id')}>
                  <div className="flex items-center gap-1">
                    ผู้ใช้งาน <ArrowUpDown size={12} />
                  </div>
                </th>
                <th className="px-6 py-4">รายละเอียด</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-200">
              {loadingLogs ? (
                [1, 2, 3, 4, 5].map(i => (
                  <tr key={i} className="animate-pulse">
                     <td colSpan={4} className="px-6 py-4"><div className="h-4 bg-base-200 rounded w-full"></div></td>
                  </tr>
                ))
              ) : sortedLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-16 text-center">
                    <div className="text-base-content/20 font-black text-3xl mb-2 italic">ไม่พบข้อมูล</div>
                    <span className="text-xs text-base-content/30 italic">ไม่พบบันทึกที่ตรงกับเงื่อนไข</span>
                  </td>
                </tr>
              ) : (
                sortedLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-base-200/20 transition-colors">
                    <td className="px-6 py-4 font-mono text-[10px] text-base-content/60">
                      {formatThaiDate(auditInstant(log.created_at))}<br/>
                      {formatThaiTime(auditInstant(log.created_at))}
                    </td>
                    <td className="px-6 py-4">
                      <span className={cn("px-2 py-0.5 rounded text-[9px] font-black font-mono", getActionColor(log.action))}>
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-base-200 flex items-center justify-center">
                           <User size={12} className="text-base-content/40" />
                        </div>
                        <span className="font-bold">{log.actor_id}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-base-content/70 font-semibold">{log.details || '-'}</div>
                      <div className="text-[9px] text-base-content/35 font-mono mt-0.5">IP: {log.ip_address || 'ภายใน'}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {!loadingLogs && totalLogs > 0 && (
          <div className="bg-base-100 p-4 border-t border-base-300 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
            <div className="text-base-content/50">
              แสดง {Math.min((currentPage - 1) * itemsPerPage + 1, totalLogs)}–{Math.min(currentPage * itemsPerPage, totalLogs)} จาก {totalLogs} รายการ
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
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setCurrentPage(p)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer",
                      currentPage === p 
                        ? "bg-primary text-primary-content shadow-md" 
                        : "bg-base-200 hover:bg-base-300 text-base-content"
                    )}
                  >
                    {p}
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
    </div>
  )
}
