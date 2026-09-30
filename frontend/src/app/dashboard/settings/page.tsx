"use client"

import React, { useState, useEffect, useRef } from "react"
import { Save, Palette, Globe, Shield, Loader2, CheckCircle2, AlertCircle, Type, ImageIcon, Layout, Eye, EyeOff, Key } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_URL, apiFetch } from "@/lib/api"
import { isPermissionDenied, permissionErrorMessage } from "@/lib/errors"
import AccessDenied from "@/components/AccessDenied"

export default function SettingsPage() {
  // Load state for the settings fetch. This used to be a boolean cleared in a `finally`, so a
  // failed fetch left the form rendered with empty values and a working Save button — pressing it
  // PATCHed empty strings over every stored value, including the LINE channel token/secret.
  // Save is now only possible from "loaded".
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "error">("loading")
  // True once a fetch has settled (either way). Only the very first load may blank the page out to
  // a spinner; a retry keeps the banner and its (disabled) retry button on screen.
  const [hasSettled, setHasSettled] = useState(false)
  // Ignores a slower, older response: two fast clicks on retry can both start a fetch before the
  // disabled state is painted.
  const fetchSeq = useRef(0)
  const [isSaving, setIsSaving] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [message, setMessage] = useState({ type: "", text: "" })
  const [showAccessToken, setShowAccessToken] = useState(false)
  const [showChannelSecret, setShowChannelSecret] = useState(false)
  const [activeTab, setActiveTab] = useState("general")
  const [settings, setSettings] = useState({
    app_name: "",
    app_logo_url: "",
    branding_text: "",
    sub_text: "",
    theme: "",
    dark_mode: "system",
    line_channel_access_token: "",
    line_channel_secret: "",
    line_liff_id: "",
    line_basic_id: ""
  })

  const themes = [
    { id: "corporate-navy", name: "น้ำเงินกรมท่า", primary: "#1e3a8a", desc: "เป็นทางการ น่าเชื่อถือ" },
    { id: "forest-evergreen", name: "เขียวป่า", primary: "#064e3b", desc: "ทันสมัย เป็นธรรมชาติ" },
    { id: "vibrant-orange", name: "ส้มสดใส", primary: "#f97316", desc: "มีพลัง อบอุ่น" },
    { id: "vibrant-red", name: "แดงเข้ม", primary: "#ef4444", desc: "โดดเด่น มีพลัง" },
    { id: "vibrant-pink", name: "ชมพูสดใส", primary: "#ec4899", desc: "สนุก สร้างสรรค์" },
    { id: "royal-purple", name: "ม่วงเข้ม", primary: "#4c1d95", desc: "พรีเมียม สร้างสรรค์" },
    { id: "minimalist-slate", name: "เทาเรียบหรู", primary: "#475569", desc: "สะอาด เรียบง่าย" },
    { id: "high-contrast-black", name: "ดำ-ขาวชัดเจน", primary: "#000000", desc: "อ่านง่าย เข้าถึงง่าย" }
  ]

  // Every tab switch re-masks both secrets (task 035). The two `show*` flags live in this component
  // and the section is only hidden when another tab is active, so without this a revealed channel
  // token would stay revealed while the admin works on another tab and is still revealed on return.
  const switchTab = (tab: string) => {
    setActiveTab(tab)
    setShowAccessToken(false)
    setShowChannelSecret(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- mount-only load calling the function declared just below it; reordering the pair was measured to trade this error for react-hooks/set-state-in-effect, not to fix it (032)
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    const seq = ++fetchSeq.current
    setLoadStatus("loading")
    try {
      const res = await apiFetch(`${API_URL}/api/v1/settings/admin`)
      if (!res.ok) {
        throw new Error(`Failed to load settings (HTTP ${res.status})`)
      }
      const data = await res.json()
      // Only a JSON object counts as loaded: a 200 carrying an HTML error page or a JSON array
      // must not unlock Save, or it would write the empty defaults over the stored values.
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("Settings response was not a JSON object")
      }
      if (seq !== fetchSeq.current) return
      // Normalize null → "" for controlled inputs
      setSettings({
        app_name: data.app_name ?? "",
        app_logo_url: data.app_logo_url ?? "",
        branding_text: data.branding_text ?? "",
        sub_text: data.sub_text ?? "",
        theme: data.theme ?? "minimalist-slate",
        dark_mode: data.dark_mode ?? "system",
        line_channel_access_token: data.line_channel_access_token ?? "",
        line_channel_secret: data.line_channel_secret ?? "",
        line_liff_id: data.line_liff_id ?? "",
        line_basic_id: data.line_basic_id ?? ""
      })
      setLoadStatus("loaded")
      setHasSettled(true)
    } catch (error) {
      if (seq !== fetchSeq.current) return
      // The 403 behaviour is unchanged: the page still renders <AccessDenied /> instead of the
      // form. Everything else (network error, 500, unparseable body) is the new "error" state.
      if (isPermissionDenied(error)) setAccessDenied(true)
      else console.error("Failed to fetch settings:", error)
      setLoadStatus("error")
      setHasSettled(true)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    // Defence in depth: the Save button below is already disabled unless the settings loaded, but
    // this is the page's only writing request and it writes every field at once.
    if (loadStatus !== "loaded") return
    setIsSaving(true)
    setMessage({ type: "", text: "" })

    try {
      // `line_basic_id` is the one field that is stored as NULL rather than "" (PATCH writes it
      // unconditionally, so a missing key used to wipe it). Send the trimmed value, or null when
      // the field is empty — an untouched NULL stays NULL and clearing the field really clears it.
      // Every other field is sent exactly as before.
      const basicId = settings.line_basic_id.trim()
      const payload = { ...settings, line_basic_id: basicId === "" ? null : basicId }

      const res = await apiFetch(`${API_URL}/api/v1/settings/admin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })

      if (res.ok) {
        setMessage({ type: "success", text: "บันทึกการตั้งค่าแล้ว" })
        document.documentElement.setAttribute("data-theme", settings.theme)
        document.cookie = `theme=${settings.theme}; path=/; max-age=31536000; SameSite=Lax`
        setTimeout(() => setMessage({ type: "", text: "" }), 3000)
      } else {
        throw new Error("บันทึกการตั้งค่าไม่สำเร็จ")
      }
    } catch (error: unknown) {
      // A 403 gets the permission-specific message; anything else keeps its own text.
      const message = (error as { message?: string })?.message || "บันทึกการตั้งค่าไม่สำเร็จ"
      setMessage({ type: "error", text: permissionErrorMessage(error, message) })
    } finally {
      setIsSaving(false)
    }
  }

  // Full-page spinner for the very first load only. A retry keeps the page (banner + disabled
  // controls) visible so the admin can see that the retry itself is running.
  if (loadStatus === "loading" && !hasSettled) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  if (accessDenied) return <AccessDenied />

  return (
    <div className="space-y-6 max-w-5xl pb-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">ตั้งค่าระบบ</h1>
          <p className="text-base-content/50 text-sm font-bold">ปรับแต่งข้อมูลและภาพลักษณ์ของระบบ</p>
        </div>
        <button 
          onClick={handleSave}
          disabled={isSaving || loadStatus !== "loaded"}
          title={loadStatus === "loaded" ? undefined : "โหลดการตั้งค่าไม่สำเร็จ จึงยังบันทึกไม่ได้ เพื่อป้องกันการเขียนทับค่าเดิม"}
          className="flex items-center justify-center gap-2 px-6 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95 disabled:opacity-50"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          บันทึก
        </button>
      </div>

      {message.text && (
        <div className={cn(
          "flex items-center gap-3 px-6 py-4 rounded-xl border animate-in fade-in slide-in-from-top-4 duration-300",
          message.type === "success" ? "bg-success/10 border-success/20 text-success" : "bg-error/10 border-error/20 text-error"
        )}>
          {message.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span className="text-sm font-bold tracking-tight">{message.text}</span>
        </div>
      )}

      {/* Amber utilities are deliberate: globals.css's @theme defines only primary/base-* tokens,
          so the bg-error / bg-success classes used by the banner above generate no CSS at all. */}
      {loadStatus !== "loaded" && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-6 py-4 rounded-xl border bg-amber-50 border-amber-300 text-amber-900 animate-in fade-in slide-in-from-top-4 duration-300">
          <AlertCircle size={18} className="shrink-0" />
          <span className="text-sm font-bold tracking-tight flex-1">
            {loadStatus === "loading"
              ? "กำลังโหลดการตั้งค่าใหม่..."
              : "โหลดการตั้งค่าไม่สำเร็จ จึงยังบันทึกไม่ได้ เพื่อป้องกันการเขียนทับค่าเดิม"}
          </span>
          <button
            type="button"
            onClick={fetchSettings}
            disabled={loadStatus === "loading"}
            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white font-black text-xs hover:bg-amber-700 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            ลองอีกครั้ง
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-6">
          <div className="flex bg-base-200/50 p-1.5 rounded-xl gap-1 max-w-md shadow-inner">
            <button
              onClick={() => switchTab("general")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all",
                activeTab === "general"
                  ? "bg-base-100 text-primary shadow-sm"
                  : "text-base-content/60 hover:text-base-content hover:bg-base-200/30"
              )}
            >
              <Globe size={14} />
              ทั่วไป
            </button>
            <button
              onClick={() => switchTab("theme")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all",
                activeTab === "theme"
                  ? "bg-base-100 text-primary shadow-sm"
                  : "text-base-content/60 hover:text-base-content hover:bg-base-200/30"
              )}
            >
              <Palette size={14} />
              ธีม
            </button>
            <button
              onClick={() => switchTab("line")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all",
                activeTab === "line"
                  ? "bg-base-100 text-primary shadow-sm"
                  : "text-base-content/60 hover:text-base-content hover:bg-base-200/30"
              )}
            >
              <Key size={14} />
              LINE OA
            </button>
          </div>

          {activeTab === "general" && (
            <section className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm animate-in fade-in duration-200">
              <div className="px-6 py-4 border-b border-base-300 bg-base-200/50 flex items-center gap-3">
                <Globe className="text-primary w-5 h-5" />
                <h2 className="font-black text-sm">ข้อมูลแอป</h2>
              </div>
              <div className="p-6 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-1.5">
                    <label className="text-xs font-black text-base-content/40 ml-1">ชื่อแอป</label>
                    <div className="relative group">
                      <Type className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30 group-focus-within:text-primary transition-colors" size={16} />
                      <input 
                        type="text" 
                        value={settings.app_name}
                        onChange={(e) => setSettings({...settings, app_name: e.target.value})}
                        className="w-full bg-base-200/50 border-none rounded-xl pl-10 pr-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-bold"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-black text-base-content/40 ml-1">URL โลโก้</label>
                    <div className="relative group">
                      <ImageIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30 group-focus-within:text-primary transition-colors" size={16} />
                      <input 
                        type="text" 
                        value={settings.app_logo_url}
                        onChange={(e) => setSettings({...settings, app_logo_url: e.target.value})}
                        className="w-full bg-base-200/50 border-none rounded-xl pl-10 pr-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-black text-base-content/40 ml-1">ชื่อแบรนด์</label>
                  <input 
                    type="text" 
                    value={settings.branding_text}
                    onChange={(e) => setSettings({...settings, branding_text: e.target.value})}
                    placeholder="เช่น WorkDee Portal"
                    className="w-full bg-base-200/50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-medium"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-black text-base-content/40 ml-1">คำโปรย</label>
                  <textarea 
                    rows={2}
                    value={settings.sub_text}
                    onChange={(e) => setSettings({...settings, sub_text: e.target.value})}
                    className="w-full bg-base-200/50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
                  />
                </div>
              </div>
            </section>
          )}

          {activeTab === "line" && (
            <section className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm animate-in fade-in duration-200">
              <div className="px-6 py-4 border-b border-base-300 bg-base-200/50 flex items-center gap-3">
                <Key className="text-primary w-5 h-5" />
                <h2 className="font-black text-sm">ตั้งค่าการเชื่อมต่อ LINE OA และ LIFF</h2>
              </div>
              <div className="p-6 space-y-6">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black text-base-content/40 ml-1">Channel Access Token ของ LINE</label>
                      <span className="text-[10px] text-base-content/30 italic">ใช้ส่งข้อความแจ้งเตือนและตอบกลับ</span>
                    </div>
                    <div className="relative group flex items-center">
                      <input 
                        type={showAccessToken ? "text" : "password"} 
                        value={settings.line_channel_access_token}
                        onChange={(e) => setSettings({...settings, line_channel_access_token: e.target.value})}
                        placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                        autoComplete="new-password"
                        className="w-full bg-base-200/50 border-none rounded-xl pl-4 pr-12 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAccessToken(!showAccessToken)}
                        aria-label={showAccessToken ? "ซ่อน Channel Access Token" : "แสดง Channel Access Token"}
                        aria-pressed={showAccessToken}
                        title={showAccessToken ? "ซ่อน" : "แสดง"}
                        className="absolute right-3 text-base-content/40 hover:text-primary transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {showAccessToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black text-base-content/40 ml-1">Channel Secret ของ LINE</label>
                      <span className="text-[10px] text-base-content/30 italic">ใช้ตรวจสอบลายเซ็นจาก LINE</span>
                    </div>
                    <div className="relative group flex items-center">
                      <input 
                        type={showChannelSecret ? "text" : "password"} 
                        value={settings.line_channel_secret}
                        onChange={(e) => setSettings({...settings, line_channel_secret: e.target.value})}
                        placeholder="8a7b6c5d4e3f..."
                        autoComplete="new-password"
                        className="w-full bg-base-200/50 border-none rounded-xl pl-4 pr-12 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowChannelSecret(!showChannelSecret)}
                        aria-label={showChannelSecret ? "ซ่อน Channel Secret" : "แสดง Channel Secret"}
                        aria-pressed={showChannelSecret}
                        title={showChannelSecret ? "ซ่อน" : "แสดง"}
                        className="absolute right-3 text-base-content/40 hover:text-primary transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {showChannelSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black text-base-content/40 ml-1">LIFF ID</label>
                      <span className="text-[10px] text-base-content/30 italic">ใช้เปิดฟอร์มลงทะเบียน</span>
                    </div>
                    <input 
                      type="text" 
                      value={settings.line_liff_id}
                      onChange={(e) => setSettings({...settings, line_liff_id: e.target.value})}
                      placeholder="2000000000-XXXXXXXX"
                      className="w-full bg-base-200/50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-black text-base-content/40 ml-1">Basic ID ของ LINE OA</label>
                    <input
                      type="text"
                      value={settings.line_basic_id}
                      onChange={(e) => setSettings({...settings, line_basic_id: e.target.value})}
                      placeholder="@416bveyk"
                      className="w-full bg-base-200/50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                    />
                    <p className="text-[11px] text-base-content/40 ml-1">
                      Basic ID ของ LINE Official Account รวมเครื่องหมาย @ — ใช้สร้างลิงก์เพิ่มเพื่อนในแท็บ Add Friend และหน้าให้เพิ่มเพื่อนของ LIFF
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeTab === "theme" && (
            <section className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm animate-in fade-in duration-200">
              <div className="px-6 py-4 border-b border-base-300 bg-base-200/50 flex items-center gap-3">
                <Palette className="text-primary w-5 h-5" />
                <h2 className="font-black text-sm">ธีมของระบบ</h2>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {themes.map((t) => (
                    <button 
                      key={t.id}
                      onClick={() => setSettings({...settings, theme: t.id})}
                      className={cn(
                        "flex items-center gap-4 p-4 rounded-2xl border-2 transition-all group relative overflow-hidden",
                        settings.theme === t.id 
                          ? "border-primary bg-primary/5 shadow-md" 
                          : "border-transparent bg-base-200/50 hover:bg-base-200"
                      )}
                    >
                      <div 
                        className="w-12 h-12 rounded-xl shadow-lg flex items-center justify-center shrink-0" 
                        style={{ backgroundColor: t.primary }}
                      >
                        <Layout className="text-white/80" size={20} />
                      </div>
                      <div className="text-left">
                        <div className="font-black text-sm mb-0.5">{t.name}</div>
                        <div className="text-[10px] text-base-content/50 font-medium">{t.desc}</div>
                      </div>
                      {settings.theme === t.id && (
                        <div className="absolute top-2 right-2">
                          <CheckCircle2 className="text-primary" size={16} />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="lg:col-span-4 space-y-6">
          <section className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-base-300 bg-base-200/50 flex items-center gap-3">
              <Shield className="text-primary w-5 h-5" />
              <h2 className="font-black text-sm">ตัวอย่าง</h2>
            </div>
            <div className="p-8 space-y-6 flex flex-col items-center text-center">
              <div className="w-20 h-20 rounded-2xl bg-base-200 flex items-center justify-center overflow-hidden">
                {settings.app_logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the logo URL is admin-supplied and can point anywhere; next/image would need a remotePatterns entry (config change, out of scope for 032)
                  <img src={settings.app_logo_url} alt="โลโก้" className="w-full h-full object-contain" />
                ) : (
                  <ImageIcon className="text-base-content/20" size={32} />
                )}
              </div>
              <div>
                <div className="font-black text-xl mb-1">{settings.app_name || "ยังไม่ตั้งชื่อแอป"}</div>
                <div className="text-sm text-base-content/60">{settings.branding_text}</div>
              </div>
              <div className="w-full h-1 bg-gradient-to-r from-transparent via-base-300 to-transparent"></div>
              <div 
                className="w-full py-3 rounded-xl font-black text-sm shadow-lg text-white" 
                style={{ backgroundColor: themes.find(t => t.id === settings.theme)?.primary || "#ccc" }}
              >
                ปุ่มหลัก
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}