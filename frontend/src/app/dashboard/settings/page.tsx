"use client"

import React, { useState, useEffect } from "react"
import { Save, Palette, Globe, Shield, Loader2, CheckCircle2, AlertCircle, Type, ImageIcon, Layout, Eye, EyeOff, Key } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_URL, apiFetch } from "@/lib/api"

export default function SettingsPage() {
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
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
    line_liff_id: ""
  })

  const themes = [
    { id: "corporate-navy", name: "Corporate Navy", primary: "#1e3a8a", desc: "Professional & Trustworthy" },
    { id: "forest-evergreen", name: "Forest Evergreen", primary: "#064e3b", desc: "Modern & Organic" },
    { id: "vibrant-orange", name: "Solar Orange", primary: "#f97316", desc: "Energetic & Warm" },
    { id: "vibrant-red", name: "Crimson Power", primary: "#ef4444", desc: "Dynamic & Bold" },
    { id: "vibrant-pink", name: "Cyber Pink", primary: "#ec4899", desc: "Playful & Creative" },
    { id: "royal-purple", name: "Royal Purple", primary: "#4c1d95", desc: "Premium & Creative" },
    { id: "minimalist-slate", name: "Minimalist Slate", primary: "#475569", desc: "Clean & Neutral" },
    { id: "high-contrast-black", name: "High Contrast", primary: "#000000", desc: "Focus & Accessibility" }
  ]

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/v1/settings/admin`)
      if (res.ok) {
        const data = await res.json()
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
          line_liff_id: data.line_liff_id ?? ""
        })
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)
    setMessage({ type: "", text: "" })

    try {
      const res = await apiFetch(`${API_URL}/api/v1/settings/admin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      })

      if (res.ok) {
        setMessage({ type: "success", text: "Settings updated successfully!" })
        document.documentElement.setAttribute("data-theme", settings.theme)
        document.cookie = `theme=${settings.theme}; path=/; max-age=31536000; SameSite=Lax`
        setTimeout(() => setMessage({ type: "", text: "" }), 3000)
      } else {
        throw new Error("Failed to update settings")
      }
    } catch (error: any) {
      setMessage({ type: "error", text: error.message })
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-5xl pb-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-base-content tracking-tight mb-1">System Settings</h1>
          <p className="text-base-content/50 font-bold text-[10px] uppercase tracking-widest">Workspace Customization & Identity</p>
        </div>
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center justify-center gap-2 px-6 py-2.5 bg-primary text-primary-content rounded-xl font-black text-sm hover:opacity-90 transition-all shadow-xl shadow-primary/20 active:scale-95 disabled:opacity-50"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Changes
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-6">
          <div className="flex bg-base-200/50 p-1.5 rounded-xl gap-1 max-w-md shadow-inner">
            <button
              onClick={() => setActiveTab("general")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all",
                activeTab === "general"
                  ? "bg-base-100 text-primary shadow-sm"
                  : "text-base-content/60 hover:text-base-content hover:bg-base-200/30"
              )}
            >
              <Globe size={14} />
              General
            </button>
            <button
              onClick={() => setActiveTab("theme")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-black transition-all",
                activeTab === "theme"
                  ? "bg-base-100 text-primary shadow-sm"
                  : "text-base-content/60 hover:text-base-content hover:bg-base-200/30"
              )}
            >
              <Palette size={14} />
              Theme
            </button>
            <button
              onClick={() => setActiveTab("line")}
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
                <h2 className="font-black text-sm uppercase tracking-wider">Application Identity</h2>
              </div>
              <div className="p-6 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-1.5">
                    <label className="text-xs font-black uppercase text-base-content/40 ml-1">App Name</label>
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
                    <label className="text-xs font-black uppercase text-base-content/40 ml-1">App Logo URL</label>
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
                  <label className="text-xs font-black uppercase text-base-content/40 ml-1">Branding Title</label>
                  <input 
                    type="text" 
                    value={settings.branding_text}
                    onChange={(e) => setSettings({...settings, branding_text: e.target.value})}
                    placeholder="e.g. FutureSign Smart Portal"
                    className="w-full bg-base-200/50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-medium"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-black uppercase text-base-content/40 ml-1">Tagline / Subtext</label>
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
                <h2 className="font-black text-sm uppercase tracking-wider">LINE OA & LIFF Integration Settings</h2>
              </div>
              <div className="p-6 space-y-6">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black uppercase text-base-content/40 ml-1">LINE Channel Access Token</label>
                      <span className="text-[10px] text-base-content/30 italic">Used for push messages & replies</span>
                    </div>
                    <div className="relative group flex items-center">
                      <input 
                        type={showAccessToken ? "text" : "password"} 
                        value={settings.line_channel_access_token}
                        onChange={(e) => setSettings({...settings, line_channel_access_token: e.target.value})}
                        placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                        className="w-full bg-base-200/50 border-none rounded-xl pl-4 pr-12 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAccessToken(!showAccessToken)}
                        className="absolute right-3 text-base-content/40 hover:text-primary transition-colors focus:outline-none"
                      >
                        {showAccessToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black uppercase text-base-content/40 ml-1">LINE Channel Secret</label>
                      <span className="text-[10px] text-base-content/30 italic">Used for signature verification</span>
                    </div>
                    <div className="relative group flex items-center">
                      <input 
                        type={showChannelSecret ? "text" : "password"} 
                        value={settings.line_channel_secret}
                        onChange={(e) => setSettings({...settings, line_channel_secret: e.target.value})}
                        placeholder="8a7b6c5d4e3f..."
                        className="w-full bg-base-200/50 border-none rounded-xl pl-4 pr-12 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowChannelSecret(!showChannelSecret)}
                        className="absolute right-3 text-base-content/40 hover:text-primary transition-colors focus:outline-none"
                      >
                        {showChannelSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black uppercase text-base-content/40 ml-1">LINE LIFF ID</label>
                      <span className="text-[10px] text-base-content/30 italic">Used to load registration form</span>
                    </div>
                    <input 
                      type="text" 
                      value={settings.line_liff_id}
                      onChange={(e) => setSettings({...settings, line_liff_id: e.target.value})}
                      placeholder="2000000000-XXXXXXXX"
                      className="w-full bg-base-200/50 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all font-mono"
                    />
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeTab === "theme" && (
            <section className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden shadow-sm animate-in fade-in duration-200">
              <div className="px-6 py-4 border-b border-base-300 bg-base-200/50 flex items-center gap-3">
                <Palette className="text-primary w-5 h-5" />
                <h2 className="font-black text-sm uppercase tracking-wider">Dynamic Theme Engine</h2>
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
                        <div className="text-[10px] text-base-content/50 font-medium uppercase tracking-tighter">{t.desc}</div>
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
              <h2 className="font-black text-sm uppercase tracking-wider">Preview</h2>
            </div>
            <div className="p-8 space-y-6 flex flex-col items-center text-center">
              <div className="w-20 h-20 rounded-2xl bg-base-200 flex items-center justify-center overflow-hidden">
                {settings.app_logo_url ? (
                  <img src={settings.app_logo_url} alt="Logo" className="w-full h-full object-contain" />
                ) : (
                  <ImageIcon className="text-base-content/20" size={32} />
                )}
              </div>
              <div>
                <div className="font-black text-xl mb-1">{settings.app_name || "Untitled App"}</div>
                <div className="text-sm text-base-content/60">{settings.branding_text}</div>
              </div>
              <div className="w-full h-1 bg-gradient-to-r from-transparent via-base-300 to-transparent"></div>
              <div 
                className="w-full py-3 rounded-xl font-black text-sm shadow-lg text-white" 
                style={{ backgroundColor: themes.find(t => t.id === settings.theme)?.primary || "#ccc" }}
              >
                Primary Action Button
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}