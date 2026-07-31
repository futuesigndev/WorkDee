"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { User, Lock, Loader2, AlertCircle, ArrowRight, Shield, Clock } from "lucide-react";
import { API_URL } from "@/lib/api";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isExpired = searchParams.get('expired') === '1';
  const [employeeId, setEmployeeId] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [siteSettings, setSiteSettings] = useState({
    appName: "FutureSign Portal",
    brandingText: "Intelligent Enterprise Bridge.",
    subText: "Your secure gateway to unified corporate resources.",
  });

  useEffect(() => {
    fetch(`${API_URL}/api/v1/settings`)
      .then((res) => res.json())
      .then((data) => {
        if (data) {
          setSiteSettings({
            appName: data.app_name || "FutureSign Portal",
            brandingText: data.branding_text || "Intelligent Enterprise Bridge.",
            subText: data.sub_text || "Your secure gateway to unified corporate resources.",
          });
          if (data.theme) {
            document.documentElement.setAttribute("data-theme", data.theme);
            document.cookie = `theme=${data.theme}; path=/; max-age=31536000; SameSite=Lax`;
          }
        }
      })
      .catch(console.error);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ employee_id: employeeId, password }),
      });

      if (response.ok) {
        // Success
        router.push("/dashboard");
      } else {
        const data = await response.json();
        setError(data.detail || "Invalid employee ID or password");
      }
    } catch (error) {
      setError("Unable to connect to service. Check network/backend.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-base-100 text-base-content overflow-hidden font-sans">
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2">
        
        {/* Left Side: Brand Visual */}
        <div className="hidden lg:flex flex-col justify-between p-12 relative bg-primary text-primary-content">
          <div className="relative z-10">
            <div className="flex items-center gap-2.5 mb-10">
              <div className="w-9 h-9 bg-white/20 backdrop-blur-md rounded-lg flex items-center justify-center border border-white/20">
                <Shield className="w-5 h-5" />
              </div>
              <span className="text-lg font-black tracking-tighter">{siteSettings.appName}</span>
            </div>
            
            <h1 className="text-4xl font-black leading-tight tracking-tight mb-6">
              {siteSettings.brandingText}
            </h1>
            <p className="text-lg font-medium opacity-70 leading-relaxed max-w-md">
              {siteSettings.subText}
            </p>
          </div>

          <div className="relative z-10 flex gap-4">
            <div className="px-4 py-2 bg-white/10 backdrop-blur-md rounded-full border border-white/10 text-[9px] font-black tracking-[3px] uppercase group cursor-default">
              System Version 1.4
            </div>
          </div>

          {/* Abstract Decorations */}
          <div className="absolute top-[20%] right-[-10%] w-[500px] h-[500px] bg-white/5 rounded-full blur-[100px]"></div>
          <div className="absolute bottom-[-10%] left-[-10%] w-72 h-72 bg-primary-content/10 rounded-full blur-3xl"></div>
        </div>

        {/* Right Side: Login Form */}
        <div className="p-8 md:p-16 lg:bg-base-300/30 flex flex-col justify-center">
          <div className="w-full max-w-md mx-auto">
            <div className="mb-10 lg:hidden flex items-center gap-3">
               <Shield className="w-8 h-8 text-primary" />
               <h1 className="text-base-content font-black text-3xl">{siteSettings.appName}</h1>
            </div>

            <div className="mb-8">
              <h3 className="text-2xl font-black text-base-content mb-1.5 tracking-tighter">Sign In</h3>
              <p className="text-base-content/40 font-bold uppercase text-[10px] tracking-[2px]">Enterprise Authentication</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-8">
              {isExpired && (
                <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 p-4 rounded-2xl flex items-center gap-3 text-sm font-bold animate-in fade-in duration-500">
                  <Clock size={18} className="shrink-0" />
                  <span>Session หมดอายุแล้ว กรุณา Sign In ใหม่อีกครั้ง</span>
                </div>
              )}
              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-600 p-5 rounded-3xl flex items-center gap-4 text-sm font-black animate-in shake duration-500">
                  <AlertCircle size={24} />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[2px] text-base-content/30 ml-1">Employee ID</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none text-base-content/30 group-focus-within:text-primary transition-colors">
                    <User size={18} />
                  </div>
                  <input
                    type="text"
                    required
                    value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                    className="block w-full pl-14 pr-5 py-3.5 bg-base-100 border-2 border-base-content/5 rounded-xl text-base-content placeholder:text-base-content/20 focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all font-black text-base shadow-sm"
                    placeholder="e.g. 110187"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[11px] font-black uppercase tracking-[3px] text-base-content/30 ml-1">Password</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none text-base-content/30 group-focus-within:text-primary transition-colors">
                    <Lock size={20} />
                  </div>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="block w-full pl-16 pr-6 py-5 bg-base-100 border-2 border-base-content/5 rounded-3xl text-base-content placeholder:text-base-content/20 focus:border-primary focus:ring-8 focus:ring-primary/5 outline-none transition-all font-black text-lg shadow-sm"
                    placeholder="Enter your password"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-2.5 px-6 py-4 bg-primary text-primary-content rounded-xl font-black text-base hover:shadow-xl hover:shadow-primary/30 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      Enter Dashboard
                      <ArrowRight size={18} strokeWidth={3} />
                    </>
                  )}
                </button>
              </div>

              <div className="text-center">
                <p className="text-xs font-bold text-base-content/30 uppercase tracking-widest">
                  Secure Access ? FutureSign Platform
                </p>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
