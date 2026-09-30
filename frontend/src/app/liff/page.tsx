"use client"

import { useEffect, useState } from "react"
import Script from "next/script"

/**
 * The endpoint URL itself: `https://<host>/liff`.
 *
 * LINE opens the **endpoint URL first** and only then the path from the LIFF URL — either as
 * `/liff/checkin` (path appended) or as `/liff?liff.state=%2Fcheckin` (the path arrives in the
 * `liff.state` query parameter, which is what LINE does when it cannot simply append a path).
 * Without a page here the employee sees a 404 instead of the check-in screen, and after an external
 * browser login LINE returns to this URL too. So this page does one job: initialise the SDK (the
 * redirect to a path is only allowed once `liff.init()` has resolved) and hand over to the page the
 * link asked for.
 *
 * It deliberately does **not** call `liff.login()`: this page is only a doorway, and the target page
 * decides what to do about the session.
 */

const MSG_OPEN_FROM_LINK = "เปิดหน้าลงเวลาหรือลงทะเบียนจากลิงก์ที่ได้รับ"
const MSG_CANNOT_START = "เปิดหน้านี้ไม่สำเร็จ กรุณากลับไปเปิดจากลิงก์ในแชต LINE อีกครั้ง"
const MSG_NO_LIFF_ID = "LIFF ID ยังไม่ได้ตั้งค่าในระบบ กรุณาติดต่อผู้ดูแลระบบ"

type Stage = "loading" | "hint" | "error"

/** Only the SDK call this page makes; the SDK is loaded from LINE's CDN at runtime. */
type LiffSdk = { init: (config: { liffId: string }) => Promise<void> }

const readLiff = (): LiffSdk | undefined => (window as unknown as { liff?: LiffSdk }).liff

/**
 * The URL that `liff.state` asks for, or `null` when there is nothing to forward to.
 *
 * LINE sends the requested path relative to the endpoint URL (the SDK does the same merge: endpoint
 * path + state path), so `/checkin` on this page means `/liff/checkin`. Only a same-origin path is
 * accepted, and the other query parameters LINE added (`liff.referrer`, `access_token`, …) are kept,
 * because dropping them would break the very initialisation this page exists for.
 */
export function stateTarget(rawState: string, href: string): string | null {
  if (!rawState.startsWith("/") || rawState.startsWith("//")) return null
  try {
    const here = new URL(href)
    const state = new URL(rawState, here.origin)
    if (state.origin !== here.origin) return null
    const basePath = here.pathname.replace(/\/+$/, "")
    const target = new URL(`${basePath}${state.pathname}${state.search}${state.hash}`, here.origin)
    const params = new URLSearchParams(here.search)
    params.delete("liff.state")
    params.forEach((value, key) => {
      if (!target.searchParams.has(key)) target.searchParams.append(key, value)
    })
    return target.toString()
  } catch {
    return null
  }
}

export default function LiffEntryPage() {
  const [stage, setStage] = useState<Stage>("loading")
  const [message, setMessage] = useState("")
  const [sdkReady, setSdkReady] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!sdkReady) return

    const enter = async () => {
      try {
        const response = await fetch("/api/v1/settings")
        const data = response.ok ? await response.json() : null
        const liffId: string | undefined = data?.line_liff_id
        if (!liffId || liffId === "YOUR_LIFF_ID") {
          setMessage(MSG_NO_LIFF_ID)
          setStage("error")
          return
        }

        const sdk = readLiff()
        if (!sdk) {
          setMessage(MSG_CANNOT_START)
          setStage("error")
          return
        }

        await sdk.init({ liffId })

        // The SDK may have forwarded already (then this never runs). If it has not, do it here — a URL
        // change is only safe after `liff.init()` has resolved.
        const rawState = new URLSearchParams(window.location.search).get("liff.state")
        const target = rawState ? stateTarget(rawState, window.location.href) : null
        if (target) {
          window.location.replace(target)
          return
        }
        setStage("hint")
      } catch {
        setMessage(MSG_CANNOT_START)
        setStage("error")
      }
    }

    enter()
  }, [sdkReady, attempt])

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setSdkReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
        <div className="w-full max-w-sm space-y-4 py-4">
          {stage === "loading" && (
            <div className="bg-base-100 rounded-3xl shadow-xl p-10 text-center border border-base-300">
              <div className="w-12 h-12 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-6 h-6 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">กำลังเปิด...</p>
            </div>
          )}

          {stage === "hint" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-[#06C755] px-6 py-6 text-center text-white">
                <p className="font-black text-base">{MSG_OPEN_FROM_LINK}</p>
              </div>
              <div className="p-5 space-y-3">
                <a
                  href="/liff/checkin"
                  className="block w-full py-4 text-center bg-[#06C755] hover:bg-[#05a848] text-white font-black text-sm rounded-2xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                >
                  ลงเวลา
                </a>
                <a
                  href="/liff/register"
                  className="block w-full py-4 text-center bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  ลงทะเบียนพนักงาน
                </a>
              </div>
            </div>
          )}

          {stage === "error" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-red-500 px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">⚠️</p>
                <p className="font-black text-base">เปิดหน้าไม่ได้</p>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-base-content/70 text-center">{message}</p>
                <button
                  onClick={() => {
                    setMessage("")
                    setStage("loading")
                    setSdkReady(false)
                    setAttempt((count) => count + 1)
                    setTimeout(() => setSdkReady(true), 0)
                  }}
                  className="w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  ลองใหม่อีกครั้ง
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
