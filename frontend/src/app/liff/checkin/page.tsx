"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Script from "next/script"

/**
 * The LIFF SDK is loaded from LINE's CDN at runtime, so it is read through a typed cast instead of
 * declaring `window.liff` globally — the register page already owns that global declaration (typed
 * as `any`), and two declarations of the same property may not disagree.
 */
type LiffSdk = {
  init: (config: { liffId: string }) => Promise<void>
  isLoggedIn: () => boolean
  login: () => void
  getIDToken: () => string | null
}

const readLiff = (): LiffSdk | undefined => (window as unknown as { liff?: LiffSdk }).liff

type RoundState = "done" | "open" | "upcoming" | "missed"

type Round = {
  round_id: string
  seq: number
  label: string
  window_start: string
  expected_time: string
  window_end: string
  photo_required: boolean
  state: RoundState
  checkin: { checked_at: string; time_status: string; flags: string[] } | null
}

type Today = {
  server_now: string
  work_date: string
  employee: { employee_id: string; full_name: string | null }
  template: { name: string; grace_minutes: number } | null
  rounds: Round[]
  workplace: string | null
  wfh_home_name: string | null
  needs_location: boolean
  message: string | null
}

type Position = { lat: number; lng: number; accuracy: number | null }
type Photo = { blob: Blob; previewUrl: string; bytes: number; sourceBytes: number }

/** The check-in screen has one stage at a time — every stage below is reachable on a phone. */
type Stage =
  | "loading"
  | "form"
  | "locating"
  | "need_location"
  | "need_photo"
  | "sending"
  | "result"
  | "error"

const API_URL = ""

// Same Thai wording as the register page for the identity failures (task 018).
const MSG_SESSION_EXPIRED = "เซสชัน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่จาก LINE"
const MSG_CANNOT_VERIFY = "ตรวจสอบตัวตนไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"
const MSG_NO_ID_TOKEN =
  "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดหน้านี้จากแอป LINE อีกครั้ง หากยังพบปัญหา กรุณาติดต่อผู้ดูแลระบบ"
const MSG_GENERIC_ERROR = "เกิดข้อผิดพลาด กรุณาติดต่อผู้ดูแลระบบ"
const MSG_ALREADY_DONE = "ลงเวลารอบนี้แล้ว"
const MSG_PHOTO_TOO_LARGE = "รูปใหญ่เกินกำหนด กรุณากดลงเวลาอีกครั้งโดยไม่แนบรูป"
const MSG_NO_LOCATION = "ไม่ได้รับตำแหน่ง"
const MSG_LOCATION_HINT = "ลงเวลาต่อได้เลย ระบบจะบันทึกไว้ให้ฝ่ายบุคคลตรวจสอบ"

/** The photo is downscaled in the phone before upload: longest side 1600 px, JPEG quality 0.8. */
const MAX_SIDE = 1600
const JPEG_QUALITY = 0.8

const STATE_LABEL: Record<RoundState, string> = {
  done: "ลงเวลาแล้ว",
  open: "ลงเวลาได้เลย",
  upcoming: "ยังไม่ถึงเวลา",
  missed: "เลยเวลาแล้ว",
}

const STATE_CLASS: Record<RoundState, string> = {
  done: "bg-emerald-500/10 text-emerald-600",
  open: "bg-primary/15 text-primary",
  upcoming: "bg-base-200 text-base-content/50",
  missed: "bg-amber-500/10 text-amber-600",
}

const TIME_STATUS_TH: Record<string, string> = {
  ON_TIME: "ตรงเวลา",
  LATE: "ช้ากว่าเวลามาตรฐาน",
  EARLY_OUT_OF_WINDOW: "เร็วกว่าช่วงของรอบ",
  LATE_OUT_OF_WINDOW: "ช้ากว่าช่วงของรอบ",
}

/** Flags in words an employee can read — no codes, no blame. */
const FLAG_TH: Record<string, string> = {
  LATE: "ช้ากว่าเวลามาตรฐานเล็กน้อย",
  OUT_OF_WINDOW: "อยู่นอกช่วงเวลาของรอบนี้",
  OUTSIDE_RADIUS: "อยู่นอกพื้นที่ที่กำหนด",
  NO_GPS: "ไม่ได้รับตำแหน่งจากเครื่อง",
  LOW_ACCURACY: "ตำแหน่งคลาดเคลื่อนค่อนข้างมาก",
  PHOTO_MISSING: "รูปยังไม่ถูกบันทึก",
  NO_LOCATION_ASSIGNED: "ยังไม่ได้กำหนดสถานที่ทำงาน",
}

export default function LiffCheckinPage() {
  const [stage, setStage] = useState<Stage>("loading")
  const [errorMsg, setErrorMsg] = useState("")
  const [idToken, setIdToken] = useState<string | null>(null)
  const [liffReady, setLiffReady] = useState(false)
  const [today, setToday] = useState<Today | null>(null)
  const [activeRound, setActiveRound] = useState<Round | null>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [result, setResult] = useState<{ message_th: string; checked_at: string; flags: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const authHeaders = useCallback(
    (token: string | null): Record<string, string> =>
      token ? { Authorization: `Bearer ${token}` } : {},
    [],
  )

  /** Load today's rounds. 401/503 are the two identity failures the employee can act on. */
  const loadToday = useCallback(
    async (token: string, silent = false) => {
      try {
        const res = await fetch(`${API_URL}/api/v1/attendance/me/today`, { headers: authHeaders(token) })
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
          const body = await res.json().catch(() => null)
          setErrorMsg(body?.detail || MSG_GENERIC_ERROR)
          setStage("error")
          return
        }
        setToday(await res.json())
        // `silent` refreshes the list without stealing the screen: the 409 notice must stay readable.
        if (!silent) setStage("form")
      } catch {
        setErrorMsg("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง")
        setStage("error")
      }
    },
    [authHeaders],
  )

  const initLiff = useCallback(
    async (liffId: string) => {
      const sdk = readLiff()
      if (!sdk) {
        setErrorMsg("ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาเปิดหน้านี้ในแอป LINE อีกครั้ง")
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
        await loadToday(token)
      } catch {
        setErrorMsg("ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาเปิดหน้านี้ในแอป LINE อีกครั้ง")
        setStage("error")
      }
    },
    [loadToday],
  )

  useEffect(() => {
    if (!liffReady) return
    const boot = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/settings`)
        if (!res.ok) throw new Error("settings")
        const data = await res.json()
        const liffId = data.line_liff_id
        if (liffId && liffId !== "YOUR_LIFF_ID") await initLiff(liffId)
        else {
          setErrorMsg("LIFF ID ยังไม่ได้ตั้งค่าในระบบ กรุณาติดต่อผู้ดูแลระบบ")
          setStage("error")
        }
      } catch {
        setErrorMsg("ไม่สามารถดึงข้อมูลการตั้งค่าเริ่มต้นได้ กรุณาติดต่อผู้ดูแลระบบ")
        setStage("error")
      }
    }
    boot()
  }, [liffReady, initLiff])

  const readPosition = (): Promise<Position | null> =>
    new Promise((resolve) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        resolve(null)
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      )
    })

  /** Downscale in the browser: the upload stays small and the GPS that counts is the one in the form. */
  const downscale = (file: File): Promise<Photo> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const image = new Image()
      image.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height))
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))
        const context = canvas.getContext("2d")
        if (!context) {
          URL.revokeObjectURL(url)
          reject(new Error("canvas"))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url)
            if (!blob) {
              reject(new Error("encode"))
              return
            }
            resolve({
              blob,
              previewUrl: URL.createObjectURL(blob),
              bytes: blob.size,
              sourceBytes: file.size,
            })
          },
          "image/jpeg",
          JPEG_QUALITY,
        )
      }
      image.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error("decode"))
      }
      image.src = url
    })

  const submit = async (gps: Position | null, shot: Photo | null) => {
    if (!idToken) return
    setStage("sending")
    setBusy(true)
    const form = new FormData()
    if (gps) {
      form.append("lat", String(gps.lat))
      form.append("lng", String(gps.lng))
      if (gps.accuracy !== null) form.append("accuracy", String(gps.accuracy))
    }
    if (shot) form.append("photo", shot.blob, "photo.jpg")
    try {
      const res = await fetch(`${API_URL}/api/v1/attendance/me/checkin`, {
        method: "POST",
        headers: authHeaders(idToken),
        body: form,
      })
      const body = await res.json().catch(() => null)
      if (res.status === 201) {
        setResult({
          message_th: body?.message_th || "บันทึกเวลาเรียบร้อยแล้ว",
          checked_at: body?.checked_at || "",
          flags: body?.flags || [],
        })
        setStage("result")
        await loadToday(idToken, true)
        return
      }
      if (res.status === 409) {
        setErrorMsg(body?.detail || MSG_ALREADY_DONE)
        setStage("error")
        await loadToday(idToken, true)
        return
      }
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
      if (res.status === 413) {
        // The photo was too big for the guard: the check-in was NOT recorded, so let the employee
        // send it again without the photo (the server keeps the file out of the record).
        setPhoto(null)
        setErrorMsg(MSG_PHOTO_TOO_LARGE)
        setStage("need_photo")
        return
      }
      setErrorMsg(body?.detail || MSG_GENERIC_ERROR)
      setStage("error")
    } catch {
      setErrorMsg("ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
      setStage("error")
    } finally {
      setBusy(false)
    }
  }

  const startCheckin = async (round: Round) => {
    setActiveRound(round)
    setPhoto(null)
    setResult(null)
    setErrorMsg("")
    const needsGps = today?.needs_location !== false
    if (!needsGps) {
      // Nothing to compare against (HR assigned no location), so do not ask for GPS at all.
      setPosition(null)
      if (round.photo_required) setStage("need_photo")
      else await submit(null, null)
      return
    }
    setStage("locating")
    const gps = await readPosition()
    if (!gps) {
      setStage("need_location")
      return
    }
    setPosition(gps)
    if (round.photo_required) setStage("need_photo")
    else await submit(gps, null)
  }

  const onPickPhoto = async (file: File | null) => {
    if (!file) return
    try {
      setPhoto(await downscale(file))
    } catch {
      setErrorMsg("อ่านรูปจากกล้องไม่ได้ กรุณาถ่ายใหม่ หรือลงเวลาต่อโดยไม่แนบรูป")
    }
  }

  const retryPosition = async () => {
    setStage("locating")
    const gps = await readPosition()
    if (!gps) {
      setStage("need_location")
      return
    }
    setPosition(gps)
    if (activeRound?.photo_required) setStage("need_photo")
    else await submit(gps, null)
  }

  const openRound = today?.rounds.find((row) => row.state === "open") || null
  const checkinFlags = (today?.rounds || []).flatMap((row) => row.checkin?.flags || [])

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setLiffReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
        <div className="w-full max-w-sm space-y-4 py-4">
          {/* === LOADING / LOCATING / SENDING === */}
          {(stage === "loading" || stage === "locating" || stage === "sending") && (
            <div className="bg-base-100 rounded-3xl shadow-xl p-10 text-center border border-base-300">
              <div className="w-12 h-12 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-6 h-6 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">
                {stage === "loading" ? "กำลังโหลด..." : stage === "locating" ? "กำลังขอตำแหน่ง..." : "กำลังบันทึกเวลา..."}
              </p>
            </div>
          )}

          {/* === FORM: today\'s rounds === */}
          {stage === "form" && today && (
            <>
              <div className="bg-[#06C755] rounded-3xl px-6 py-6 text-white shadow-xl">
                <p className="text-xs text-white/80">ลงเวลาวันนี้</p>
                <p className="font-black text-lg mt-0.5">{today.employee.full_name || today.employee.employee_id}</p>
                <p className="text-white/80 text-xs mt-0.5">
                  {today.template?.name || ""} · {today.work_date}
                </p>
                {(today.workplace || today.wfh_home_name) && (
                  <p className="text-white/80 text-xs mt-1 break-words">
                    สถานที่: {[today.workplace, today.wfh_home_name].filter(Boolean).join(" / ")}
                  </p>
                )}
              </div>

              {today.message && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
                  <p className="text-sm text-base-content/80">{today.message}</p>
                </div>
              )}

              {today.rounds.length > 0 && (
                <div className="bg-base-100 rounded-3xl border border-base-300 shadow-lg divide-y divide-base-300">
                  {today.rounds.map((round) => (
                    <div key={round.round_id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-sm text-base-content truncate">{round.label}</p>
                        <p className="text-xs text-base-content/50 mt-0.5">
                          {round.window_start}–{round.window_end} (มาตรฐาน {round.expected_time})
                        </p>
                        {round.checkin && (
                          <p className="text-xs text-base-content/60 mt-1">
                            ลงเวลาแล้ว {new Date(round.checkin.checked_at).toLocaleTimeString("th-TH", {
                              timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit",
                            })}{" "}
                            · {TIME_STATUS_TH[round.checkin.time_status] || round.checkin.time_status}
                          </p>
                        )}
                      </div>
                      <span className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold ${STATE_CLASS[round.state]}`}>
                        {STATE_LABEL[round.state]}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {openRound ? (
                <button
                  onClick={() => startCheckin(openRound)}
                  disabled={busy}
                  className="w-full py-5 bg-[#06C755] hover:bg-[#05a848] disabled:opacity-60 text-white font-black text-base rounded-3xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                >
                  ลงเวลา · {openRound.label}
                </button>
              ) : (
                today.rounds.length > 0 && (
                  <div className="bg-base-100 rounded-2xl border border-base-300 p-4 text-center">
                    <p className="text-sm text-base-content/60">
                      ยังไม่ถึงเวลาของรอบถัดไป หรือเลยเวลาของรอบนี้แล้ว
                    </p>
                  </div>
                )
              )}

              {(checkinFlags.length > 0 || (today.rounds || []).some((row) => row.checkin)) && (
                <p className="text-center text-xs text-base-content/40">
                  ฝ่ายบุคคลจะตรวจสอบและยืนยันผลให้คุณอีกครั้ง
                </p>
              )}
            </>
          )}

          {/* === NO LOCATION === */}
          {stage === "need_location" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-amber-500 px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">📍</p>
                <p className="font-black text-lg">{MSG_NO_LOCATION}</p>
                <p className="text-white/80 text-xs mt-1">{MSG_LOCATION_HINT}</p>
              </div>
              <div className="p-5 space-y-3">
                <button
                  onClick={retryPosition}
                  className="w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  ลองใหม่
                </button>
                <button
                  onClick={async () => {
                    setPosition(null)
                    if (activeRound?.photo_required) setStage("need_photo")
                    else await submit(null, null)
                  }}
                  className="w-full py-4 bg-[#06C755] hover:bg-[#05a848] text-white font-black text-sm rounded-2xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                >
                  ลงเวลาต่อโดยไม่มีตำแหน่ง
                </button>
              </div>
            </div>
          )}

          {/* === PHOTO STEP === */}
          {stage === "need_photo" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-[#06C755] px-6 py-6 text-white text-center">
                <p className="text-3xl mb-1">📷</p>
                <p className="font-black text-base">แนบรูปยืนยัน</p>
                <p className="text-white/80 text-xs mt-1">รูปนี้ช่วยยืนยันว่าคุณอยู่ที่ทำงานจริง</p>
              </div>
              <div className="p-5 space-y-3">
                {errorMsg && <p className="text-xs text-amber-600 text-center">{errorMsg}</p>}
                {photo ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.previewUrl}
                      alt="รูปที่ถ่าย"
                      data-photo-bytes={photo.bytes}
                      data-source-bytes={photo.sourceBytes}
                      className="w-full rounded-2xl border border-base-300"
                    />
                    <button
                      onClick={() => fileInput.current?.click()}
                      className="w-full py-3 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                    >
                      ถ่ายใหม่
                    </button>
                    <button
                      onClick={() => submit(position, photo)}
                      disabled={busy}
                      className="w-full py-4 bg-[#06C755] hover:bg-[#05a848] disabled:opacity-60 text-white font-black text-sm rounded-2xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                    >
                      ใช้รูปนี้ แล้วลงเวลา
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => fileInput.current?.click()}
                      className="w-full py-4 bg-[#06C755] hover:bg-[#05a848] text-white font-black text-sm rounded-2xl shadow-lg shadow-[#06C755]/30 transition-all active:scale-95"
                    >
                      ถ่ายรูป
                    </button>
                    <button
                      onClick={() => submit(position, null)}
                      disabled={busy}
                      className="w-full py-3 bg-base-200 hover:bg-base-300 disabled:opacity-60 font-bold text-sm rounded-2xl transition-all"
                    >
                      ลงเวลาต่อโดยไม่แนบรูป
                    </button>
                  </>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  capture="user"
                  className="hidden"
                  onChange={(event) => onPickPhoto(event.target.files?.[0] || null)}
                />
              </div>
            </div>
          )}

          {/* === RESULT === */}
          {stage === "result" && result && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-[#06C755] px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">✅</p>
                <p className="font-black text-base">บันทึกแล้ว</p>
              </div>
              <div className="p-5 space-y-3 text-center">
                <p className="text-sm text-base-content/80">{result.message_th}</p>
                {result.checked_at && (
                  <p className="text-xs text-base-content/50">
                    เวลาที่บันทึก{" "}
                    {new Date(result.checked_at).toLocaleTimeString("th-TH", {
                      timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit",
                    })}
                  </p>
                )}
                {result.flags.length > 0 && (
                  <ul className="text-left text-xs text-base-content/60 space-y-1 bg-base-200/60 rounded-2xl p-3">
                    {result.flags.map((flag) => (
                      <li key={flag}>• {FLAG_TH[flag] || flag}</li>
                    ))}
                    <li className="text-base-content/50">ไม่ต้องกังวลนะ</li>
                  </ul>
                )}
                <button
                  onClick={() => today && loadToday(idToken || "")}
                  className="w-full py-3 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  ดูสถานะวันนี้
                </button>
              </div>
            </div>
          )}

          {/* === ERROR === */}
          {stage === "error" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-red-500 px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">⚠️</p>
                <p className="font-black text-base">ยังบันทึกไม่ได้</p>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-base-content/70 text-center">{errorMsg}</p>
                <button
                  onClick={() => {
                    setErrorMsg("")
                    if (idToken) loadToday(idToken)
                    else {
                      setStage("loading")
                      setLiffReady(false)
                      setTimeout(() => setLiffReady(true), 0)
                    }
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
