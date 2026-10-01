"use client"

import React, { useState, useEffect } from 'react'
import { 
  Users, 
  ShieldCheck, 
  MessageSquare, 
  History,
  TrendingUp,
  Zap,
  ArrowUpRight
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { BRAND_FALLBACK } from '@/lib/brand'
import { API_URL, apiFetch } from '@/lib/api'
import { isPermissionDenied } from '@/lib/errors'
import AccessDenied from '@/components/AccessDenied'

/**
 * The system overview (task 056).
 *
 * This page is the dashboard that used to live at `/dashboard` (task 006): four system counters (users,
 * roles, pending LINE registrations, how many audit rows the last list returned) and two placeholder
 * panels. Task 056 moved it under System Settings **unchanged** — same requests, same numbers, same
 * wording — because `/dashboard` is now the HR dashboard, and an HR user has no use for system counters.
 * Nothing about how the numbers are fetched changed; only the route and the menu row did.
 */
export default function SystemOverview() {
  const [stats, setStats] = useState({
    users: 0,
    roles: 0,
    linePending: 0,
    recentLogs: 0
  })
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [u, r, l, lg] = await Promise.all([
          apiFetch(`${API_URL}/api/v1/users`),
          apiFetch(`${API_URL}/api/v1/roles`),
          apiFetch(`${API_URL}/api/v1/line/pending`),
          apiFetch(`${API_URL}/api/v1/logs`)
        ]);
        
        setStats({
          users: u.ok ? (await u.json()).length : 0,
          roles: r.ok ? (await r.json()).length : 0,
          linePending: l.ok ? (await l.json()).length : 0,
          recentLogs: lg.ok ? (await lg.json()).length : 0,
        })
      } catch (err) {
        if (isPermissionDenied(err)) setAccessDenied(true)
        else console.error(err)
      } finally {
        setLoading(false)
      }
    }
    fetchStats()
  }, [])

  const cards = [
    { label: 'ผู้ใช้งาน', value: stats.users, icon: Users, color: 'text-primary', bg: 'bg-primary/5', path: '/dashboard/users' },
    { label: 'บทบาทในระบบ', value: stats.roles, icon: ShieldCheck, color: 'text-info', bg: 'bg-info/5', path: '/dashboard/roles' },
    { label: 'รอตรวจ LINE', value: stats.linePending, icon: MessageSquare, color: 'text-[#06C755]', bg: 'bg-[#06C755]/5', path: '/dashboard/line' },
    { label: 'บันทึกการใช้งานล่าสุด', value: stats.recentLogs, icon: History, color: 'text-warning', bg: 'bg-warning/5', path: '/dashboard/logs' },
  ]

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div className="relative overflow-hidden bg-primary/10 p-8 rounded-3xl border border-primary/10">
        <div className="relative z-10">
          <h1 className="text-3xl font-black tracking-tight text-primary">ภาพรวมระบบ</h1>
          <p className="mt-2 text-base-content/60 max-w-lg font-medium">
            ยินดีต้อนรับสู่ระบบผู้ดูแลของ {BRAND_FALLBACK} การตั้งค่าทั้งหมดจัดการผ่าน Core-API และระบบสิทธิ์ภายในแอป
          </p>
        </div>
        <Zap className="absolute right-[-20px] top-[-20px] text-primary/10 w-48 h-48 rotate-12" />
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {cards.map((card, i) => (
          <div key={i} className="bg-base-100 p-6 rounded-2xl border border-base-300 hover:shadow-xl hover:shadow-base-content/5 transition-all group cursor-pointer relative overflow-hidden">
            <div className={cn("inline-flex p-3 rounded-xl mb-4 transition-transform group-hover:scale-110", card.bg, card.color)}>
              <card.icon size={24} />
            </div>
            <div className="text-3xl font-black tracking-tight mb-1">{loading ? '...' : card.value}</div>
            <div className="text-xs font-black text-base-content/40">{card.label}</div>
            <ArrowUpRight className="absolute top-4 right-4 text-base-content/10 group-hover:text-primary transition-colors" size={20} />
          </div>
        ))}
      </div>

      {/* Quick View / Graph Slot */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 bg-base-100 rounded-3xl border border-base-300 p-8">
          <div className="flex items-center justify-between mb-8">
             <h3 className="text-xl font-black flex items-center gap-2"><TrendingUp className="text-primary" /> การใช้งานระบบ</h3>
             <span className="text-[10px] font-black bg-base-200 px-3 py-1 rounded-full text-base-content/40">อัปเดตทันที</span>
          </div>
          <div className="h-[250px] w-full bg-base-200/50 rounded-2xl flex items-center justify-center border-2 border-dashed border-base-300">
             <span className="text-xs text-base-content/20 font-black">กราฟการใช้งานจะแสดงที่นี่</span>
          </div>
        </div>

        <div className="bg-primary text-primary-content rounded-3xl p-8 flex flex-col justify-between shadow-2xl shadow-primary/30">
          <div>
            <h3 className="text-xl font-black mb-2">ระบบความปลอดภัย</h3>
            <p className="text-xs opacity-80 font-medium">กำลังตรวจสอบเซสชันอยู่ ทุกการใช้งานถูกบันทึกไว้ใน Redis 7</p>
          </div>
          <div className="mt-8 space-y-4">
            <div className="flex items-center justify-between text-sm border-b border-primary-content/10 pb-2">
               <span className="opacity-70">เซสชันที่ใช้งานอยู่</span>
               <span className="font-bold">ปกติ</span>
            </div>
            <div className="flex items-center justify-between text-sm border-b border-primary-content/10 pb-2">
               <span className="opacity-70">สถานะ Token</span>
               <span className="font-bold">100%</span>
            </div>
            <button className="w-full bg-primary-content text-primary py-3 rounded-xl font-black text-sm hover:scale-105 active:scale-95 transition-all mt-4">
              รายงานความปลอดภัย
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
