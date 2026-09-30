"use client"

import { useEffect, useState } from "react"
import { PORTAL_SERVICES, PortalService, serviceHref } from "./services"

/**
 * "ศูนย์รวมบริการ" — the service hub (task 031).
 *
 * The Rich Menu is the fast lane for the jobs people do every day; this page is the **complete list**, and
 * it is where a new service shows up without touching the menu (which has exactly four tiles). It is the
 * master spec's "Dock & Portal" idea: the menu stays small, the hub grows.
 *
 * Deliberate differences from `/liff/checkin`, `/liff/rounds` and `/liff/history`:
 *
 * * **No LINE SDK and no identity call.** The hub shows nothing personal — it is the same list for
 *   everybody — so there is nothing to log in for, and it must also work in an external browser. The only
 *   server call is the public `GET /api/v1/settings`, and it **fails soft**: a missing product name shows
 *   the fallback instead of an error card (the hub itself never depends on the server).
 * * **The "soon" cards are not links.** They are plain `<div>`s with no link, no button and no tab stop, so
 *   nobody can tap into a page that does not exist yet. That they are visible at all is on purpose: staff
 *   see what is coming, and switching one on is a one-line edit in `services.ts`.
 *
 * The signature green header, the card shapes and the Thai wording come from the other LIFF pages, so all
 * of them look like one product.
 */

const FALLBACK_APP_NAME = "WorkDee"
const MSG_LIVE_TITLE = "ใช้งานได้ตอนนี้"
const MSG_SOON_TITLE = "เร็วๆ นี้"
const MSG_SOON_CHIP = "เร็วๆ นี้"
const MSG_SUBTITLE = "บริการทั้งหมดของพนักงานในที่เดียว"
const MSG_FOOTER = "มีบริการใหม่เพิ่มเข้ามาเรื่อยๆ"

/** One card of the "ใช้งานได้ตอนนี้" section: a service plus the link it opens. */
type LiveEntry = { service: PortalService; href: string }

export default function LiffPortalPage() {
  const [appName, setAppName] = useState(FALLBACK_APP_NAME)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch("/api/v1/settings")
        if (!res.ok) return
        const settings = await res.json()
        const name = String(settings?.app_name ?? "").trim()
        // An empty or blank name keeps the fallback — the header must never be empty.
        if (alive && name) setAppName(name)
      } catch {
        // Fail soft on purpose: the hub needs nothing from the server.
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [])

  // A `live` entry without a usable `/liff/…` link is skipped rather than rendered as a dead link
  // (`services.ts` reports it as a registry problem, so the mistake cannot hide).
  const liveEntries: LiveEntry[] = PORTAL_SERVICES.flatMap((service) => {
    const href = serviceHref(service)
    return href ? [{ service, href }] : []
  })
  const soonServices = PORTAL_SERVICES.filter((service) => service.status === "soon")

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
      <div className="w-full max-w-sm space-y-4 py-4">
        <div className="bg-[#06C755] rounded-3xl px-6 py-6 text-white shadow-xl">
          <p className="text-xs text-white/80 truncate" data-app-name="true" title={appName}>
            {appName}
          </p>
          <p className="font-black text-lg mt-0.5">ศูนย์รวมบริการ</p>
          <p className="text-white/80 text-xs mt-1">{MSG_SUBTITLE}</p>
        </div>

        {liveEntries.length > 0 && (
          <section className="space-y-3">
            <h2 className="px-2 text-xs font-bold text-base-content/50">{MSG_LIVE_TITLE}</h2>
            {liveEntries.map(({ service, href }) => (
              <a
                key={service.key}
                href={href}
                data-service={service.key}
                data-status="live"
                className="block bg-base-100 rounded-3xl border border-base-300 shadow-lg px-5 py-5 min-h-[48px] hover:border-[#06C755] transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-sm text-base-content break-words">{service.title}</p>
                    <p className="text-xs text-base-content/60 mt-0.5 break-words">{service.description}</p>
                  </div>
                  <span aria-hidden="true" className="shrink-0 text-lg font-black text-[#06C755]">
                    ›
                  </span>
                </div>
              </a>
            ))}
          </section>
        )}

        {soonServices.length > 0 && (
          <section className="space-y-3">
            <h2 className="px-2 text-xs font-bold text-base-content/50">{MSG_SOON_TITLE}</h2>
            {soonServices.map((service) => (
              <div
                key={service.key}
                data-service={service.key}
                data-status="soon"
                aria-disabled="true"
                className="bg-base-200/60 rounded-3xl border border-base-300 px-5 py-4 opacity-70"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-bold text-sm text-base-content/70 break-words">{service.title}</p>
                  <span className="shrink-0 px-3 py-1 rounded-full text-[11px] font-bold bg-base-300 text-base-content/60">
                    {MSG_SOON_CHIP}
                  </span>
                </div>
                <p className="text-xs text-base-content/50 mt-0.5 break-words">{service.description}</p>
              </div>
            ))}
          </section>
        )}

        <p className="text-center text-[11px] text-base-content/40 px-2">{MSG_FOOTER}</p>
      </div>
    </div>
  )
}
