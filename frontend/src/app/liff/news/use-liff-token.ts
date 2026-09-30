"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * The LINE boot every LIFF page needs, in one place (task 039).
 *
 * The news feature has **two** routes (the list and one item), and both must identify the employee the
 * same way, so the sequence that used to live inside `/liff/history` and `/liff/checkin` is factored out
 * here instead of being copy-pasted: read the public `GET /api/v1/settings` for the LIFF id, `liff.init`
 * it, make sure the employee is logged in (`liff.login()` when not — LINE then comes back and the page
 * remounts), then take the ID token. The **token is the only identity** the news API accepts: the pages
 * never send an employee id, and the server never trusts one from a client.
 *
 * `stage` is deliberately owned here and handed out with its setter: the page marks `"ready"` once its
 * own first request succeeded, exactly like the history page does, so the loading card stays up until
 * there is something real to show.
 */

/** The slice of the LINE LIFF SDK this app uses. */
export type LiffSdk = {
  init: (config: { liffId: string }) => Promise<void>
  isLoggedIn: () => boolean
  login: () => void
  getIDToken: () => string | null
}

export type Stage = "loading" | "ready" | "error"

export const readLiff = (): LiffSdk | undefined => (window as unknown as { liff?: LiffSdk }).liff

// The same Thai wording the check-in and history pages use for the identity failures (task 018/021), so
// one problem reads the same everywhere.
export const MSG_SESSION_EXPIRED = "เซสชัน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE"
export const MSG_CANNOT_VERIFY = "ตรวจสอบตัวตนไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"
export const MSG_NO_ID_TOKEN =
  "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดหน้านี้จากแอป LINE อีกครั้ง หากยังพบปัญหา กรุณาติดต่อผู้ดูแลระบบ"
export const MSG_GENERIC_ERROR = "เกิดข้อผิดพลาด กรุณาติดต่อผู้ดูแลระบบ"
export const MSG_CANNOT_CONNECT = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง"
export const MSG_NO_LIFF = "ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาเปิดหน้านี้ในแอป LINE อีกครั้ง"
export const MSG_NO_LIFF_ID = "LIFF ID ยังไม่ได้ตั้งค่าในระบบ กรุณาติดต่อผู้ดูแลระบบ"
export const MSG_SETTINGS_FAILED = "ไม่สามารถดึงข้อมูลการตั้งค่าเริ่มต้นได้ กรุณาติดต่อผู้ดูแลระบบ"

export function useLiffToken() {
  const [stage, setStage] = useState<Stage>("loading")
  const [errorMsg, setErrorMsg] = useState("")
  const [idToken, setIdToken] = useState<string | null>(null)
  const [liffReady, setLiffReady] = useState(false)

  useEffect(() => {
    if (!liffReady) return
    const boot = async () => {
      try {
        const sdk = readLiff()
        if (!sdk) {
          setErrorMsg(MSG_NO_LIFF)
          setStage("error")
          return
        }
        const res = await fetch("/api/v1/settings")
        if (!res.ok) throw new Error("settings")
        const settings = await res.json()
        const liffId: string | undefined = settings.line_liff_id
        if (!liffId || liffId === "YOUR_LIFF_ID") {
          setErrorMsg(MSG_NO_LIFF_ID)
          setStage("error")
          return
        }
        await sdk.init({ liffId })
        if (!sdk.isLoggedIn()) {
          sdk.login()
          return
        }
        let token: string | null = null
        try {
          token = sdk.getIDToken()
        } catch {
          token = null
        }
        if (typeof token !== "string" || !token) {
          setErrorMsg(MSG_NO_ID_TOKEN)
          setStage("error")
          return
        }
        setIdToken(token)
      } catch {
        setErrorMsg(MSG_SETTINGS_FAILED)
        setStage("error")
      }
    }
    void boot()
  }, [liffReady])

  /**
   * Run the whole boot again. `<Script onReady>` fires once, so `liffReady` is cycled false → true to
   * re-run the effect (the history/check-in page trick) — without the second half the page would sit on
   * the loading card for ever.
   */
  const retry = useCallback(() => {
    setErrorMsg("")
    setStage("loading")
    setLiffReady(false)
    setTimeout(() => setLiffReady(true), 0)
  }, [])

  return { stage, setStage, errorMsg, setErrorMsg, idToken, liffReady, setLiffReady, retry }
}

/**
 * The Thai sentence for a failed read, from a status the news API can answer.
 *
 * 401 = the LINE token is no longer usable, 503 = LINE itself could not be asked, and 403/404 carry the
 * server's own Thai sentence (unbound, pending, rejected, revoked or "ที่อ่านไม่ได้แล้ว") — which is
 * exactly the flow the other LIFF pages already have, so nothing new is invented here.
 */
export async function messageForFailure(res: Response): Promise<string> {
  if (res.status === 401) return MSG_SESSION_EXPIRED
  if (res.status === 503) return MSG_CANNOT_VERIFY
  const body = await res.json().catch(() => null)
  return body?.detail || MSG_GENERIC_ERROR
}
