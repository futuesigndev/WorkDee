"use client"

import React, { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  ClipboardCheck,
  Loader2,
  MapPin,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { API_URL, apiFetch } from '@/lib/api'
import { isPermissionDenied } from '@/lib/errors'
import { bangkokDay } from '@/lib/datetime'
import { flagLabel } from '@/lib/attendance-labels'
import AccessDenied from '@/components/AccessDenied'

/**
 * The HR dashboard (task 056): what happened today, in Bangkok terms.
 *
 * `/dashboard` used to show system counters; those moved to System Settings → "ภาพรวมระบบ"
 * (`/dashboard/system-overview`) because an HR user opens this page to work through today's check-ins.
 *
 * Permissions: the page asks the menu list first and only calls the attendance summary when the account
 * actually holds `attendance-records`. A viewer without it gets a plain Thai notice instead of cards — and
 * no request that would answer 403 noisily. The backend keeps enforcing the same key, so the page cannot
 * widen anybody's access.
 *
 * Each card owns its own request state, so one failing call cannot blank the others: the three scalar cards
 * share the summary request, the location card has its own (the same endpoint) and the link card has none.
 */
const RECORDS_PERMISSION = 'attendance-records'
const RECORDS_PATH = '/dashboard/operation/attendance-records'
const LOCATION_CAP = 10
const EMPTY_DAY_TH = 'วันนี้ยังไม่มีการลงเวลา'
const CARD_ERROR_TH = 'โหลดข้อมูลไม่สำเร็จ'
const NO_PERMISSION_TH = 'คุณไม่มีสิทธิ์ดูข้อมูลการลงเวลา กรุณาติดต่อผู้ดูแลระบบ'
const MENU_ERROR_TH = 'โหลดเมนูไม่สำเร็จ กรุณาลองใหม่'

type FetchState = 'loading' | 'ready' | 'error'

interface LocationCount {
  location_id: string | null
  location_name: string
  count: number
}

interface MenuNode {
  key?: string
  granted?: boolean
  children?: MenuNode[]
}

interface SummaryCard {
  state: FetchState
  total: number
  pending: number
  flags: [string, number][]
}

interface LocationCard {
  state: FetchState
  items: LocationCount[]
}

/** Is `attendance-records` granted anywhere in the (nested) menu list the shell uses? */
function holdsRecordsMenu(items: MenuNode[]): boolean {
  return (items || []).some(
    (item) =>
      (item.key === RECORDS_PERMISSION && item.granted !== false) || holdsRecordsMenu(item.children ?? []),
  )
}

export default function HrDashboard() {
  const [permission, setPermission] = useState<'checking' | 'granted' | 'denied' | 'unknown'>('checking')
  const [accessDenied, setAccessDenied] = useState(false)
  const [summary, setSummary] = useState<SummaryCard>({ state: 'loading', total: 0, pending: 0, flags: [] })
  const [locations, setLocations] = useState<LocationCard>({ state: 'loading', items: [] })
  const [reloadKey, setReloadKey] = useState(0)

  const today = bangkokDay()
  const range = `date_from=${today}&date_to=${today}`

  // 1. Do we hold the attendance-records menu at all? (An account without it must not call the summary.)
  useEffect(() => {
    let cancelled = false
    const checkPermission = async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/v1/auth/me/menus`)
        if (cancelled) return
        if (res.status === 403) {
          setAccessDenied(true)
          setPermission('unknown')
          return
        }
        if (!res.ok) {
          setPermission('unknown')
          return
        }
        const menus = await res.json()
        setPermission(holdsRecordsMenu(Array.isArray(menus) ? menus : []) ? 'granted' : 'denied')
      } catch (err) {
        if (cancelled) return
        if (isPermissionDenied(err)) setAccessDenied(true)
        setPermission('unknown')
      }
    }
    checkPermission()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  // 2. The three scalar cards (check-ins today, pending review, flags by type).
  useEffect(() => {
    if (permission !== 'granted') return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reload button must show the loading state again; this is a one-shot fetch kicked off by the effect, the same pattern the roles and logs pages use (032/056)
    setSummary((previous) => ({ ...previous, state: 'loading' }))
    const load = async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/v1/attendance/checkins/summary?${range}`)
        if (cancelled) return
        if (!res.ok) {
          setSummary({ state: 'error', total: 0, pending: 0, flags: [] })
          return
        }
        const body = await res.json()
        setSummary({
          state: 'ready',
          total: body?.total ?? 0,
          pending: body?.by_review_status?.PENDING_REVIEW ?? 0,
          flags: Object.entries(body?.by_flag ?? {}).sort(
            (a, b) => (b[1] as number) - (a[1] as number),
          ) as [string, number][],
        })
      } catch {
        if (!cancelled) setSummary({ state: 'error', total: 0, pending: 0, flags: [] })
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [permission, range, reloadKey])

  // 3. The location breakdown, its own request on purpose (see the note above).
  useEffect(() => {
    if (permission !== 'granted') return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same one-shot fetch as the summary card above, deliberately a separate request so one failure cannot blank the other card (056)
    setLocations((previous) => ({ ...previous, state: 'loading' }))
    const load = async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/v1/attendance/checkins/summary?${range}`)
        if (cancelled) return
        if (!res.ok) {
          setLocations({ state: 'error', items: [] })
          return
        }
        const body = await res.json()
        setLocations({ state: 'ready', items: (body?.by_location ?? []) as LocationCount[] })
      } catch {
        if (!cancelled) setLocations({ state: 'error', items: [] })
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [permission, range, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  if (accessDenied) return <AccessDenied />

  const cardClass = 'bg-base-100 rounded-2xl border border-base-300 p-6 flex flex-col gap-3'
  const errorLine = (
    <p className="text-xs font-bold text-error flex items-center gap-1.5">
      <AlertCircle size={14} /> {CARD_ERROR_TH}
    </p>
  )
  const loadingLine = (
    <p className="text-xs font-bold text-base-content/40 flex items-center gap-1.5">
      <Loader2 size={14} className="animate-spin" /> กำลังโหลด...
    </p>
  )

  const shownLocations = locations.items.slice(0, LOCATION_CAP)
  const hiddenLocations = locations.items.slice(LOCATION_CAP)
  const hiddenCount = hiddenLocations.reduce((total, item) => total + item.count, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-base-content flex items-center gap-2">
            <ClipboardCheck className="text-primary" /> ภาพรวมการลงเวลาวันนี้
          </h1>
          <p className="text-base-content/50 text-sm font-bold">ข้อมูลของวันนี้ตามเวลาไทย (Asia/Bangkok)</p>
        </div>
        <button
          type="button"
          onClick={reload}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-base-100 border border-base-300 rounded-xl font-black text-xs text-base-content/60 hover:text-primary transition-all active:scale-95 cursor-pointer"
        >
          <RefreshCw size={14} /> รีเฟรช
        </button>
      </div>

      {permission === 'checking' && <div className={cardClass}>{loadingLine}</div>}

      {permission === 'unknown' && (
        <div className={cardClass}>
          <p className="text-xs font-bold text-error flex items-center gap-1.5">
            <AlertCircle size={14} /> {MENU_ERROR_TH}
          </p>
          <button
            type="button"
            onClick={reload}
            className="self-start px-4 py-2 bg-primary text-primary-content rounded-xl font-black text-xs hover:opacity-90 active:scale-95 transition-all cursor-pointer"
          >
            ลองใหม่
          </button>
        </div>
      )}

      {permission === 'denied' && (
        <div className={cardClass}>
          <p className="text-sm font-bold text-base-content/70">{NO_PERMISSION_TH}</p>
        </div>
      )}

      {permission === 'granted' && (
        <>
          {summary.state === 'ready' && summary.total === 0 && (
            <p className="text-xs font-bold text-base-content/50">{EMPTY_DAY_TH}</p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className={cardClass}>
              <div className="text-xs font-black text-base-content/40">ลงเวลาวันนี้</div>
              {summary.state === 'loading' && loadingLine}
              {summary.state === 'error' && errorLine}
              {summary.state === 'ready' && (
                <>
                  <div className="text-3xl font-black tracking-tight">{summary.total}</div>
                  <div className="text-xs font-bold text-base-content/40">รายการ</div>
                </>
              )}
            </div>

            <div className={cardClass}>
              <div className="text-xs font-black text-base-content/40">รอตรวจวันนี้</div>
              {summary.state === 'loading' && loadingLine}
              {summary.state === 'error' && errorLine}
              {summary.state === 'ready' && (
                <>
                  <div className="text-3xl font-black tracking-tight">{summary.pending}</div>
                  <div className="text-xs font-bold text-base-content/40">รายการ</div>
                </>
              )}
            </div>

            <div className={cardClass}>
              <div className="text-xs font-black text-base-content/40">ธงวันนี้</div>
              {summary.state === 'loading' && loadingLine}
              {summary.state === 'error' && errorLine}
              {summary.state === 'ready' &&
                (summary.flags.length === 0 ? (
                  <p className="text-xs font-bold text-base-content/40">ไม่มีธง</p>
                ) : (
                  <ul className="space-y-1.5">
                    {summary.flags.map(([code, count]) => (
                      <li key={code} className="flex items-center justify-between text-xs font-bold">
                        <span className="text-base-content/70 flex items-center gap-1.5">
                          <TriangleAlert size={13} className="text-warning" /> {flagLabel(code)}
                        </span>
                        <span className="font-black">{count}</span>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className={`${cardClass} lg:col-span-2`}>
              <div className="text-xs font-black text-base-content/40 flex items-center gap-1.5">
                <MapPin size={13} /> ลงเวลาตามสถานที่วันนี้
              </div>
              {locations.state === 'loading' && loadingLine}
              {locations.state === 'error' && errorLine}
              {locations.state === 'ready' &&
                (locations.items.length === 0 ? (
                  <p className="text-xs font-bold text-base-content/40">{EMPTY_DAY_TH}</p>
                ) : (
                  <ul className="divide-y divide-base-200">
                    {shownLocations.map((item) => (
                      <li
                        key={`${item.location_id ?? 'none'}-${item.location_name}`}
                        className="flex items-center justify-between gap-4 py-2 text-xs font-bold"
                      >
                        <span className="text-base-content/70 truncate">{item.location_name}</span>
                        <span className="font-black shrink-0">{item.count}</span>
                      </li>
                    ))}
                    {hiddenLocations.length > 0 && (
                      <li className="flex items-center justify-between gap-4 py-2 text-xs font-bold text-base-content/50">
                        <span>อื่น ๆ ({hiddenLocations.length} สถานที่)</span>
                        <span className="font-black">{hiddenCount}</span>
                      </li>
                    )}
                  </ul>
                ))}
            </div>

            <div className={cardClass}>
              <div className="text-xs font-black text-base-content/40">รายการลงเวลา</div>
              <p className="text-xs font-bold text-base-content/50">
                เปิดหน้ารายการลงเวลาเพื่อดูรายละเอียด ตรวจสอบรายการที่มีธง หรือส่งออกไฟล์ CSV
              </p>
              <a
                href={RECORDS_PATH}
                className="mt-auto w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-content rounded-xl font-black text-xs hover:opacity-90 active:scale-95 transition-all"
              >
                ไปที่รายการลงเวลา <ArrowUpRight size={14} />
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
