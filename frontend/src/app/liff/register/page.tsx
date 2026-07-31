"use client"

import { useEffect, useState } from "react"
import Script from "next/script"

declare global {
  interface Window {
    liff: any
  }
}

type Stage = "loading" | "form" | "submitting" | "success" | "error" | "already_pending" | "already_approved"

const API_URL = ""

export default function LiffRegisterPage() {
  const [stage, setStage] = useState<Stage>("loading")
  const [liffProfile, setLiffProfile] = useState<{ userId: string; displayName: string; pictureUrl?: string } | null>(null)
  const [employeeId, setEmployeeId] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [liffReady, setLiffReady] = useState(false)

  const initLiff = async (liffId: string) => {
    try {
      await window.liff.init({ liffId })

      if (!window.liff.isLoggedIn()) {
        window.liff.login()
        return
      }

      const profile = await window.liff.getProfile()
      setLiffProfile({
        userId: profile.userId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
      })
      setStage("form")
    } catch (err: any) {
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
  }, [liffReady])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!employeeId.trim() || !liffProfile) return

    setStage("submitting")

    try {
      const res = await fetch(`${API_URL}/api/v1/line/register`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        body: JSON.stringify({
          line_user_id: liffProfile.userId,
          employee_id: employeeId.trim().toUpperCase(),
          display_name: liffProfile.displayName,
        }),
      })

      const data = await res.json()

      if (res.status === 200 || res.status === 201) {
        if (data.status === "PENDING") {
          setStage("already_pending")
        } else {
          setStage("success")
        }
      } else if (res.status === 409) {
        setStage("already_approved")
      } else {
        setErrorMsg(data.detail || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง")
        setStage("error")
      }
    } catch (err) {
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
                    <img src={liffProfile.pictureUrl} alt="Profile" className="w-20 h-20 rounded-full mx-auto border-4 border-white/50 shadow-lg mb-3"/>
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
                  <p className="text-[10px] text-base-content/40 font-bold uppercase tracking-widest mb-1">LINE User ID</p>
                  <p className="font-mono text-xs text-base-content/60 break-all">{liffProfile.userId}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="space-y-1.5">
                    <label className="text-sm font-black text-base-content">รหัสพนักงาน (Employee ID)</label>
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
