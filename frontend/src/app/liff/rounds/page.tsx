"use client"

import { useCallback, useEffect, useState } from "react"
import Script from "next/script"

/**
 * "รอบของฉัน" — the employee's own check-in schedule (task 030).
 *
 * Reached from the third live rich-menu button (`https://liff.line.me/<LIFF_ID>/rounds`), which lands on
 * the `/liff` entry page and is forwarded here exactly like `/liff/checkin` and `/liff/history`.
 *
 * It answers the question a person asks *before* checking in: which rounds do I have, when can I check
 * in, where am I allowed to, and do I need a photo? Everything on it comes from
 * `GET /api/v1/attendance/me/rounds`, which is built from the verified LINE token — the page never asks
 * who the employee is, and the API sends no coordinates, no location/round ids and no home-point
 * details, so nothing here can leak a place.
 *
 * Wording rules: Thai, calm, and never a reason to feel accused — a photo requirement is stated as
 * "มีการถ่ายรูปประกอบ" (there is a photo step), never as a condition that can be failed.
 */

type LiffSdk = {
  init: (config: { liffId: string }) => Promise<void>
  isLoggedIn: () => boolean
  login: () => void
  getIDToken: () => string | null
}

const readLiff = (): LiffSdk | undefined => (window as unknown as { liff?: LiffSdk }).liff

type RoundsTemplate = { name: string; grace_minutes: number }

type RoundsRound = {
  seq: number
  name: string | null
  window_start: string
  expected_time: string
  window_end: string
  photo_required: boolean
}

type RoundsWorkplace = { name: string; radius_meters: number }

type RoundsWfh = { enabled: boolean; home_name: string | null }

type RoundsPayload = {
  has_schedule: boolean
  message: string | null
  template: RoundsTemplate | null
  rounds: RoundsRound[]
  workplace: RoundsWorkplace | null
  wfh: RoundsWfh | null
}

type Stage = "loading" | "ready" | "error"

// The same Thai wording as the check-in and history pages for the identity failures (task 018/021/029).
const MSG_SESSION_EXPIRED = "เซสชัน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE"
const MSG_CANNOT_VERIFY = "ตรวจสอบตัวตนไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"
const MSG_NO_ID_TOKEN =
  "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดหน้านี้จากแอป LINE อีกครั้ง หากยังพบปัญหา กรุณาติดต่อผู้ดูแลระบบ"
const MSG_GENERIC_ERROR = "เกิดข้อผิดพลาด กรุณาติดต่อผู้ดูแลระบบ"
const MSG_CANNOT_CONNECT = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง"
const MSG_NO_LIFF = "ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาเปิดหน้านี้ในแอป LINE อีกครั้ง"
const MSG_NO_LIFF_ID = "LIFF ID ยังไม่ได้ตั้งค่าในระบบ กรุณาติดต่อผู้ดูแลระบบ"
const MSG_EMPTY_ROUNDS = "ยังไม่มีรอบในแม่แบบนี้ กรุณาติดต่อฝ่ายบุคคล"
const MSG_CONTACT_HR = "กรุณาติดต่อฝ่ายบุคคล"

export default function LiffRoundsPage() {
  const [stage, setStage] = useState<Stage>("loading")
  const [errorMsg, setErrorMsg] = useState("")
  const [idToken, setIdToken] = useState<string | null>(null)
  const [liffReady, setLiffReady] = useState(false)
  const [data, setData] = useState<RoundsPayload | null>(null)

  const loadRounds = useCallback(async (token: string) => {
    try {
      const res = await fetch("/api/v1/attendance/me/rounds", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        setErrorMsg(MSG_SESSION_EXPIRED)
        setStage("error")
        return
      }
      if (res.status === 503) {
        setErrorMsg(MSG_CANNOT_VERIFY)
        setStage("error")
        return
      }
      if (!res.ok) {
        // 403/404 (not bound, pending, revoked) carry a Thai sentence from the server — show it as is.
        const body = await res.json().catch(() => null)
        setErrorMsg(body?.detail || MSG_GENERIC_ERROR)
        setStage("error")
        return
      }
      const body = (await res.json()) as RoundsPayload
      setData(body)
      setStage("ready")
    } catch {
      setErrorMsg(MSG_CANNOT_CONNECT)
      setStage("error")
    }
  }, [])

  const initLiff = useCallback(
    async (liffId: string) => {
      const sdk = readLiff()
      if (!sdk) {
        setErrorMsg(MSG_NO_LIFF)
        setStage("error")
        return
      }
      try {
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
        await loadRounds(token)
      } catch {
        setErrorMsg(MSG_NO_LIFF)
        setStage("error")
      }
    },
    [loadRounds],
  )

  useEffect(() => {
    if (!liffReady) return
    const boot = async () => {
      try {
        const res = await fetch("/api/v1/settings")
        if (!res.ok) throw new Error("settings")
        const settings = await res.json()
        const liffId: string | undefined = settings.line_liff_id
        if (liffId && liffId !== "YOUR_LIFF_ID") await initLiff(liffId)
        else {
          setErrorMsg(MSG_NO_LIFF_ID)
          setStage("error")
        }
      } catch {
        setErrorMsg("ไม่สามารถดึงข้อมูลการตั้งค่าเริ่มต้นได้ กรุณาติดต่อผู้ดูแลระบบ")
        setStage("error")
      }
    }
    boot()
  }, [liffReady, initLiff])

  const template = data?.template ?? null
  const rounds = data?.rounds ?? []
  const serverMessage = (data?.message || "").trim()

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setLiffReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
        <div className="w-full max-w-sm space-y-4 py-4">
          <div className="bg-[#06C755] rounded-3xl px-6 py-6 text-white shadow-xl">
            <p className="text-xs text-white/80">ตารางของฉัน</p>
            <p className="font-black text-lg mt-0.5">รอบลงเวลาของฉัน</p>
            <p className="text-white/80 text-xs mt-1">สิ่งที่ฝ่ายบุคคลกำหนดให้คุณ</p>
          </div>

          {/* === LOADING === */}
          {stage === "loading" && (
            <div className="bg-base-100 rounded-3xl shadow-xl p-10 text-center border border-base-300">
              <div className="w-12 h-12 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-6 h-6 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">กำลังโหลด...</p>
            </div>
          )}

          {/* === READY: no schedule assigned (not an error — HR simply has not set it up yet) === */}
          {stage === "ready" && data && !data.has_schedule && (
            <div className="bg-base-100 rounded-3xl border border-base-300 shadow-lg p-6 space-y-3 text-center">
              <p className="text-4xl">🗓️</p>
              <p className="text-sm text-base-content/80" data-no-schedule="true">
                {serverMessage || MSG_EMPTY_ROUNDS}
              </p>
              {!serverMessage.includes(MSG_CONTACT_HR) && (
                <p className="text-xs text-base-content/50">{MSG_CONTACT_HR}</p>
              )}
            </div>
          )}

          {/* === READY: schedule === */}
          {stage === "ready" && data && data.has_schedule && (
            <>
              {template && (
                <div className="bg-base-100 rounded-3xl border border-base-300 shadow-lg overflow-hidden">
                  <div className="px-5 py-4">
                    <p className="text-[11px] text-base-content/50">แม่แบบการลงเวลา</p>
                    <p className="font-black text-base text-base-content mt-0.5 break-words">
                      {template.name}
                    </p>
                    {template.grace_minutes > 0 && (
                      <p className="text-xs text-base-content/60 mt-1">
                        ผ่อนผันสาย {template.grace_minutes} นาที
                      </p>
                    )}
                  </div>
                </div>
              )}

              {rounds.length === 0 ? (
                <div className="bg-base-100 rounded-3xl border border-base-300 p-6 text-center">
                  <p className="text-sm text-base-content/70">{MSG_EMPTY_ROUNDS}</p>
                </div>
              ) : (
                rounds.map((round) => (
                  <div
                    key={round.seq}
                    className="bg-base-100 rounded-3xl border border-base-300 shadow-lg overflow-hidden"
                    data-round={round.seq}
                  >
                    <div className="px-5 py-4 space-y-1.5">
                      <p className="font-bold text-sm text-base-content break-words">
                        {round.name || `รอบที่ ${round.seq}`}
                      </p>
                      <p className="text-xs text-base-content/70">
                        ลงเวลาได้ตั้งแต่ {round.window_start} ถึง {round.window_end} น.
                      </p>
                      <p className="text-xs text-base-content/60">
                        เวลามาตรฐาน {round.expected_time} น.
                      </p>
                      {round.photo_required && (
                        <p className="text-xs text-base-content/60">📷 มีการถ่ายรูปประกอบ</p>
                      )}
                    </div>
                  </div>
                ))
              )}

              {data.workplace && (
                <div className="bg-base-100 rounded-3xl border border-base-300 shadow-lg px-5 py-4">
                  <p className="text-xs text-base-content/70" data-workplace="true">
                    สถานที่ลงเวลา: {data.workplace.name} · ลงเวลาได้ในรัศมี{" "}
                    {data.workplace.radius_meters} เมตร
                  </p>
                </div>
              )}

              {data.wfh?.enabled && (
                <div className="bg-base-100 rounded-3xl border border-base-300 shadow-lg px-5 py-4">
                  <p className="text-xs text-base-content/70" data-wfh="true">
                    {data.wfh.home_name
                      ? `เปิดโหมดทำงานที่บ้าน: ${data.wfh.home_name}`
                      : "เปิดโหมดทำงานที่บ้าน"}
                  </p>
                </div>
              )}

              <a
                href="/liff/checkin"
                className="block w-full text-center py-4 bg-[#06C755] hover:opacity-90 text-white font-black text-sm rounded-2xl shadow-lg transition-all"
              >
                ไปหน้าลงเวลา
              </a>
            </>
          )}

          {/* === ERROR === */}
          {stage === "error" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-amber-500 px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">⚠️</p>
                <p className="font-black text-base">ยังดูรอบลงเวลาไม่ได้</p>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-base-content/70 text-center">{errorMsg}</p>
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg("")
                    if (idToken) {
                      // The token is still in hand: just ask again.
                      setStage("loading")
                      loadRounds(idToken)
                      return
                    }
                    // Nothing loaded yet: run the whole boot again. `<Script onReady>` fires only once,
                    // so `liffReady` is cycled false → true to re-run the effect (the check-in page's
                    // trick) — without the second half the page would sit on the loading card for ever.
                    setStage("loading")
                    setLiffReady(false)
                    setTimeout(() => setLiffReady(true), 0)
                  }}
                  className="w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  ลองใหม่อีกครั้ง
                </button>
              </div>
            </div>
          )}

          <p className="text-center text-[11px] text-base-content/40 px-2">
            หากข้อมูลไม่ตรงกับที่ตกลงไว้ กรุณาแจ้งฝ่ายบุคคล
          </p>
        </div>
      </div>
    </>
  )
}
