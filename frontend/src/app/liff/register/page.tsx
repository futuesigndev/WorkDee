"use client"

import { useEffect, useState } from "react"
import Script from "next/script"

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the LINE LIFF SDK ships no type package; the real shape is only known at runtime (032)
    liff: any
  }
}

type Stage = "loading" | "form" | "submitting" | "success" | "error" | "already_pending" | "already_approved" | "not_friend"

const API_URL = ""

// Thai messages for the verified-identity flow (task 018). The backend sends the same wording in
// `detail`; these constants are used when a status arrives without a usable body.
const MSG_SESSION_EXPIRED = "เซสชัน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE"
const MSG_CANNOT_VERIFY = "ตรวจสอบตัวตนไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"
const MSG_NO_ID_TOKEN =
  "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดหน้านี้จากแอป LINE อีกครั้ง หากยังพบปัญหา กรุณาติดต่อผู้ดูแลระบบ"
const MSG_GENERIC_ERROR = "เกิดข้อผิดพลาด กรุณาติดต่อผู้ดูแลระบบ"

export default function LiffRegisterPage() {
  const [stage, setStage] = useState<Stage>("loading")
  const [liffProfile, setLiffProfile] = useState<{ userId: string; displayName: string; pictureUrl?: string } | null>(null)
  const [idToken, setIdToken] = useState<string | null>(null)
  const [employeeId, setEmployeeId] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [liffReady, setLiffReady] = useState(false)
  const [lineBasicId, setLineBasicId] = useState("")
  const [recheckingFriendship, setRecheckingFriendship] = useState(false)
  const [pollTimedOut, setPollTimedOut] = useState(false)
  const [inLineClient, setInLineClient] = useState(false)

  /**
   * The LINE ID token is the ONLY thing the backend accepts as proof of who is calling (task 018):
   * it is verified against LINE server-side, so neither this page nor anyone else can claim to be
   * a LINE user without one. It needs the `openid` scope on the LIFF app — without it LINE returns
   * null, and the page stops instead of letting the employee submit an identity nothing can check.
   * Never logged, never stored anywhere outside this tab's memory.
   */
  const readIdToken = (): string | null => {
    try {
      const token = window.liff?.getIDToken?.()
      return typeof token === "string" && token.length > 0 ? token : null
    } catch (err) {
      console.warn("liff.getIDToken() unavailable:", err)
      return null
    }
  }

  /**
   * True when the employee has added the WorkDee OA as a friend.
   * Fails OPEN (treated as a friend) when getFriendship() is unavailable or throws, so a
   * client/SDK limitation can never block registration — only a confirmed "not a friend" may.
   */
  const isFriendOfOA = async (): Promise<boolean> => {
    try {
      const friendship = await window.liff.getFriendship()
      return friendship?.friendFlag !== false
    } catch (err) {
      console.warn("liff.getFriendship() unavailable — skipping the friendship gate:", err)
      return true
    }
  }

  const handleRecheckFriendship = async () => {
    setRecheckingFriendship(true)
    try {
      if (await isFriendOfOA()) {
        setStage("form")
      }
    } finally {
      setRecheckingFriendship(false)
    }
  }

  const initLiff = async (liffId: string) => {
    try {
      await window.liff.init({ liffId })

      // liff.closeWindow() only works inside the LINE client — remember where we are so the
      // "already approved" screen can hide its close button in an external browser.
      setInLineClient(window.liff.isInClient())

      if (!window.liff.isLoggedIn()) {
        window.liff.login()
        return
      }

      const token = readIdToken()
      if (!token) {
        setErrorMsg(MSG_NO_ID_TOKEN)
        setStage("error")
        return
      }
      setIdToken(token)

      const profile = await window.liff.getProfile()
      setLiffProfile({
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
      })

      // Gate: LINE never delivers (or bills) a push to someone who has not added the OA as a
      // friend, so letting a non-friend register would leave them stuck with no notification.
      if (!(await isFriendOfOA())) {
        setStage("not_friend")
        return
      }

      setStage("form")
    } catch (err: unknown) {
      console.error("LIFF init error:", err)
      setErrorMsg("ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาเปิดหน้านี้ในแอป LINE อีกครั้ง")
      setStage("error")
    }
  }

  useEffect(() => {
    const fetchLiffIdAndInit = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/settings`)
        if (!res.ok) {
          throw new Error("Failed to fetch settings")
        }
        const data = await res.json()
        setLineBasicId(data.line_basic_id || "")
        const fetchedLiffId = data.line_liff_id
        
        if (fetchedLiffId && fetchedLiffId !== "YOUR_LIFF_ID") {
          await initLiff(fetchedLiffId)
        } else {
          setErrorMsg("LIFF ID ยังไม่ได้ตั้งค่าในระบบ กรุณาติดต่อผู้ดูแลระบบ")
          setStage("error")
        }
      } catch (err) {
        console.error("LIFF init error:", err)
        setErrorMsg("ไม่สามารถดึงข้อมูลการตั้งค่าเริ่มต้นได้ กรุณาติดต่อผู้ดูแลระบบ")
        setStage("error")
      }
    }

    if (liffReady) {
      fetchLiffIdAndInit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchLiffIdAndInit is re-created on every render; only the SDK-ready flag should re-run this (032)
  }, [liffReady])

  // While the request is pending, poll the status endpoint so the employee is not stuck
  // depending on a push notification that may never arrive. The call goes to /line/status (no id
  // in the URL) and carries the verified LINE ID token — the backend answers for that token's own
  // LINE account only.
  useEffect(() => {
    if (stage !== "already_pending" || !liffProfile || !idToken) return

    const POLL_INTERVAL_MS = 5000
    const MAX_ATTEMPTS = 120 // 120 x 5s = 10 minutes, then stop and show a passive message
    let attempts = 0
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined

    const stopPolling = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }

    const poll = async () => {
      attempts += 1
      try {
        const res = await fetch(`${API_URL}/api/v1/line/status`, {
          headers: { Authorization: `Bearer ${idToken}` },
        })
        if (res.ok) {
          const data = await res.json()
          if (data.status === "APPROVED") {
            stopPolling()
            if (!cancelled) setStage("already_approved")
            return
          }
        } else if (res.status === 401) {
          // The token expired while the employee waited — ask them to reopen the page from LINE.
          stopPolling()
          if (!cancelled) {
            setErrorMsg(MSG_SESSION_EXPIRED)
            setStage("error")
          }
          return
        }
      } catch (err) {
        console.warn("LINE status poll failed:", err)
      }
      if (attempts >= MAX_ATTEMPTS) {
        stopPolling()
        if (!cancelled) setPollTimedOut(true)
      }
    }

    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      stopPolling()
    }
  }, [stage, liffProfile, idToken])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!employeeId.trim() || !liffProfile || !idToken) return

    setStage("submitting")

    try {
      const res = await fetch(`${API_URL}/api/v1/line/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The only identity the backend trusts. `line_user_id` is deliberately NOT sent any more
          // (a client-built id is forgeable) — the backend reads it from this token.
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          employee_id: employeeId.trim().toUpperCase(),
          display_name: liffProfile.displayName,
        }),
      })

      let data: { status?: string; detail?: string } | null = null
      try {
        data = await res.json()
      } catch {
        data = null
      }

      if (res.status === 200 || res.status === 201) {
        if (data?.status === "PENDING") {
          setStage("already_pending")
        } else {
          setStage("success")
        }
      } else if (res.status === 409) {
        setStage("already_approved")
      } else if (res.status === 401) {
        // Task 047/D18: 401 covers two different situations — no LINE token was sent at all, or LINE
        // no longer accepts the one that was. The backend sends a different sentence for each, so show
        // what it actually said; the local constant is only the fallback when the body is unusable.
        setErrorMsg(data?.detail || MSG_SESSION_EXPIRED)
        setStage("error")
      } else if (res.status === 503) {
        setErrorMsg(MSG_CANNOT_VERIFY)
        setStage("error")
      } else {
        setErrorMsg(data?.detail || MSG_GENERIC_ERROR)
        setStage("error")
      }
    } catch {
      setErrorMsg("ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้ กรุณาลองใหม่ภายหลัง")
      setStage("error")
    }
  }

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setLiffReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">

          {/* === LOADING === */}
          {stage === "loading" && (
            <div className="flex flex-col items-center gap-5 py-16 text-center">
              <div className="w-20 h-20 rounded-3xl bg-[#06C755]/15 flex items-center justify-center animate-pulse">
                <svg viewBox="0 0 36 36" className="w-10 h-10 fill-[#06C755]">
                  <path d="M18 2C9.163 2 2 8.477 2 16.4c0 5.207 3.163 9.763 7.918 12.395.347.192.46.615.25.954l-1.37 2.236c-.21.34.048.748.437.748h17.53c.39 0 .647-.408.438-.748l-1.37-2.236c-.21-.34-.098-.762.25-.954C30.837 26.163 34 21.607 34 16.4 34 8.477 26.837 2 18 2z"/>
                </svg>
              </div>
              <div>
                <p className="font-bold text-base-content/70">กำลังโหลด LINE SDK...</p>
                <p className="text-xs text-base-content/40 mt-1">กรุณารอสักครู่</p>
              </div>
            </div>
          )}

          {/* === FORM === */}
          {stage === "form" && liffProfile && (
            <div className="bg-base-100 rounded-3xl shadow-2xl overflow-hidden border border-base-300">
              {/* Header */}
              <div className="bg-[#06C755] px-6 pt-10 pb-14 text-white text-center relative overflow-hidden">
                <div className="absolute inset-0 opacity-10">
                  <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white"></div>
                  <div className="absolute -bottom-4 -left-4 w-24 h-24 rounded-full bg-white"></div>
                </div>
                <div className="relative">
                  {liffProfile.pictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the LINE profile picture is served from the LINE CDN (host varies); next/image would need a remotePatterns entry (config change, out of scope for 032)
                    <img src={liffProfile.pictureUrl} alt="รูปโปรไฟล์ LINE" className="w-20 h-20 rounded-full mx-auto border-4 border-white/50 shadow-lg mb-3"/>
                  ) : (
                    <div className="w-20 h-20 rounded-full mx-auto border-4 border-white/50 shadow-lg mb-3 bg-white/20 flex items-center justify-center text-3xl font-black">
                      {liffProfile.displayName.charAt(0)}
                    </div>
                  )}
                  <p className="font-black text-lg">{liffProfile.displayName}</p>
                  <p className="text-white/70 text-xs mt-0.5">ลงทะเบียนผูกบัญชี LINE OA</p>
                </div>
              </div>

              {/* Form Body */}
              <div className="px-6 -mt-6 pb-8 relative">
                <div className="bg-base-100 rounded-2xl border border-base-300 shadow-lg p-5 mb-5">
                  <p className="text-[10px] text-base-content/40 font-bold uppercase tracking-widest mb-1">รหัสผู้ใช้ LINE</p>
                  <p className="font-mono text-xs text-base-content/60 break-all">{liffProfile.userId}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="space-y-1.5">
                    <label className="text-sm font-black text-base-content">รหัสพนักงาน</label>
                    <input
                      type="text"
                      value={employeeId}
                      onChange={(e) => setEmployeeId(e.target.value)}
                      placeholder="เช่น EMP001"
                      required
                      autoFocus
                      className="w-full border border-base-300 rounded-2xl px-4 py-3.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#06C755]/40 focus:border-[#06C755] bg-base-100 transition-all uppercase"
                    />
                    <p className="text-xs text-base-content/40">กรอกรหัสพนักงานที่ได้รับจากฝ่ายทรัพยากรบุคคล</p>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-4 bg-[#06C755] hover:bg-[#05a848] text-white font-black text-sm rounded-2xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                  >
                    ส่งคำขอผูกบัญชี
                  </button>
                </form>

                <p className="text-center text-xs text-base-content/30 mt-5 leading-relaxed">
                  คำขอของคุณจะถูกส่งให้ผู้ดูแลระบบอนุมัติ<br/>
                  คุณจะได้รับการแจ้งเตือนเมื่อการผูกบัญชีสำเร็จ
                </p>
              </div>
            </div>
          )}

          {/* === SUBMITTING === */}
          {stage === "submitting" && (
            <div className="bg-base-100 rounded-3xl shadow-2xl p-10 text-center border border-base-300">
              <div className="w-16 h-16 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-8 h-8 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">กำลังส่งคำขอ...</p>
            </div>
          )}

          {/* === SUCCESS === */}
          {stage === "success" && (
            <div className="bg-base-100 rounded-3xl shadow-2xl overflow-hidden border border-base-300">
              <div className="bg-[#06C755] px-6 py-10 text-center text-white">
                <div className="w-20 h-20 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4 text-4xl">
                  ✅
                </div>
                <h2 className="font-black text-xl">ส่งคำขอสำเร็จ!</h2>
                <p className="text-white/80 text-sm mt-1">รอการอนุมัติจากผู้ดูแลระบบ</p>
              </div>
              <div className="px-6 py-8 text-center text-sm text-base-content/60 leading-relaxed">
                <p>คำขอผูกบัญชี LINE ของคุณถูกบันทึกเรียบร้อยแล้ว</p>
                <p className="mt-2">เมื่อผู้ดูแลระบบอนุมัติ คุณจะได้รับข้อความยืนยันทาง LINE</p>
              </div>
            </div>
          )}

          {/* === NOT A FRIEND OF THE OA === */}
          {stage === "not_friend" && (
            <div className="bg-base-100 rounded-3xl shadow-2xl overflow-hidden border border-base-300">
              <div className="bg-[#06C755] px-6 py-10 text-center text-white">
                <div className="text-5xl mb-4">👋</div>
                <h2 className="font-black text-xl">กรุณาเพิ่มเพื่อนก่อนลงทะเบียน</h2>
                <p className="text-white/80 text-sm mt-1">ต้องเป็นเพื่อนกับ LINE OA ของบริษัทก่อน</p>
              </div>
              <div className="px-6 py-8 text-center space-y-4">
                <p className="text-sm text-base-content/60 leading-relaxed">
                  ระบบจะแจ้งผลการอนุมัติผ่านข้อความ LINE<br/>
                  จึงจำเป็นต้องเพิ่มเพื่อนกับบัญชีทางการของบริษัทก่อนจึงจะลงทะเบียนได้
                </p>
                {lineBasicId ? (
                  <a
                    href={`https://line.me/R/ti/p/${lineBasicId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full py-4 bg-[#06C755] hover:bg-[#05a848] text-white font-black text-sm rounded-2xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                  >
                    เพิ่มเพื่อน LINE OA
                  </a>
                ) : (
                  <p className="text-xs text-base-content/40">
                    ยังไม่ได้ตั้งค่าบัญชีทางการในระบบ กรุณาติดต่อผู้ดูแลระบบ
                  </p>
                )}
                <button
                  onClick={handleRecheckFriendship}
                  disabled={recheckingFriendship}
                  className="w-full py-3 bg-base-200 hover:bg-base-300 disabled:opacity-50 text-sm font-bold rounded-2xl transition-all"
                >
                  {recheckingFriendship ? "กำลังตรวจสอบ..." : "เพิ่มเพื่อนแล้ว ลองอีกครั้ง"}
                </button>
              </div>
            </div>
          )}

          {/* === ALREADY PENDING === */}
          {stage === "already_pending" && (
            <div className="bg-base-100 rounded-3xl shadow-2xl overflow-hidden border border-base-300">
              <div className="bg-amber-500 px-6 py-10 text-center text-white">
                <div className="text-5xl mb-4">⏳</div>
                <h2 className="font-black text-xl">รอการอนุมัติ</h2>
                <p className="text-white/80 text-sm mt-1">คำขอของคุณอยู่ระหว่างการพิจารณา</p>
              </div>
              <div className="px-6 py-8 text-center text-sm text-base-content/60 leading-relaxed">
                <p>คุณได้ส่งคำขอผูกบัญชีไปแล้วก่อนหน้านี้</p>
                <p className="mt-2">กรุณารอให้ผู้ดูแลระบบตรวจสอบและอนุมัติคำขอของคุณ</p>
                {pollTimedOut ? (
                  <p className="mt-4 text-xs text-base-content/40">
                    ยังไม่ได้รับการอนุมัติ — คุณสามารถปิดหน้านี้แล้วกลับมาตรวจสอบภายหลังได้
                  </p>
                ) : (
                  <p className="mt-4 text-xs text-[#06C755] font-bold animate-pulse">
                    กำลังตรวจสอบสถานะอัตโนมัติทุก 5 วินาที...
                  </p>
                )}
              </div>
            </div>
          )}

          {/* === ALREADY APPROVED === */}
          {stage === "already_approved" && (
            <div className="bg-base-100 rounded-3xl shadow-2xl overflow-hidden border border-base-300">
              <div className="bg-blue-500 px-6 py-10 text-center text-white">
                <div className="text-5xl mb-4">🔗</div>
                <h2 className="font-black text-xl">บัญชีถูกผูกแล้ว</h2>
                <p className="text-white/80 text-sm mt-1">LINE ของคุณถูกผูกกับระบบเรียบร้อยแล้ว</p>
              </div>
              <div className="px-6 py-8 text-center text-sm text-base-content/60 leading-relaxed">
                <p>บัญชี LINE นี้ถูกผูกกับพนักงานในระบบเรียบร้อยแล้ว</p>
                <p className="mt-2">หากต้องการเปลี่ยนแปลง กรุณาติดต่อผู้ดูแลระบบ</p>
                {inLineClient ? (
                  <button
                    onClick={() => {
                      try {
                        window.liff.closeWindow()
                      } catch (err) {
                        console.warn("liff.closeWindow() failed:", err)
                      }
                    }}
                    className="mt-6 px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white text-sm font-bold rounded-2xl shadow-lg shadow-blue-500/30 transition-all active:scale-95"
                  >
                    ปิดหน้าต่างนี้
                  </button>
                ) : (
                  <p className="mt-4 text-xs text-base-content/40">คุณสามารถปิดหน้านี้ได้เลย</p>
                )}
              </div>
            </div>
          )}

          {/* === ERROR === */}
          {stage === "error" && (
            <div className="bg-base-100 rounded-3xl shadow-2xl overflow-hidden border border-base-300">
              <div className="bg-red-500 px-6 py-10 text-center text-white">
                <div className="text-5xl mb-4">⚠️</div>
                <h2 className="font-black text-xl">เกิดข้อผิดพลาด</h2>
              </div>
              <div className="px-6 py-8 text-center space-y-4">
                <p className="text-sm text-base-content/60 leading-relaxed">{errorMsg}</p>
                <button
                  onClick={() => { setStage("loading"); setErrorMsg(""); setLiffReady(false); setTimeout(() => setLiffReady(true), 0) }}
                  className="px-6 py-2.5 bg-base-200 hover:bg-base-300 text-sm font-bold rounded-xl transition-all"
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
