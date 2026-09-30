"use client";

import { useEffect, useState } from "react";
import { 
  LayoutDashboard, 
  Users, 
  Settings, 
  LogOut, 
  Menu as MenuIcon, 
  ShieldCheck,
  Bell
} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

const themes = [
  { id: "minimalist-slate", name: "Minimalist Slate", color: "bg-slate-600" },
  { id: "corporate-navy", name: "Corporate Navy", color: "bg-[#1e3a5f]" },
  { id: "industrial-amber", name: "Industrial Amber", color: "bg-[#b45309]" },
  { id: "forest-evergreen", name: "Forest Evergreen", color: "bg-[#064e3b]" },
  { id: "royal-purple", name: "Royal Purple", color: "bg-[#4c1d95]" },
  { id: "high-contrast-black", name: "Midnight Onyx", color: "bg-black" },
];

export default function ThemePreviewPage() {
  const [currentTheme, setCurrentTheme] = useState("minimalist-slate");
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [activeMenu, setActiveMenu] = useState("Dashboard");

  const changeTheme = (themeId: string) => {
    setCurrentTheme(themeId);
    document.documentElement.setAttribute("data-theme", themeId);
    // eslint-disable-next-line react-hooks/immutability -- writing the theme cookie is this preview page's whole purpose (it is read back on the next load); moving the write into an effect would change when it happens (032)
    document.cookie = "theme=" + themeId + "; path=/; max-age=31536000";
  };

  useEffect(() => {
    const theme = document.cookie.split("; ").find(row => row.startsWith("theme="))?.split("=")[1];
    if (theme) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs the selected theme from the cookie on first paint; that is the purpose of this effect (032)
      setCurrentTheme(theme);
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, []);

  return (
    <div className="flex h-screen overflow-hidden transition-colors duration-300">
      {/* Sidebar */}
      <aside className={cn(
        "bg-[var(--color-primary)] text-white w-64 flex-shrink-0 flex flex-col transition-all duration-300",
        !isSidebarOpen && "-ml-64"
      )}>
        <div className="p-6 flex items-center gap-3 border-b border-white/10">
          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">WorkDee</span>
        </div>
        
        <nav className="flex-1 p-4 space-y-1">
          {[
            { icon: LayoutDashboard, label: "Dashboard", href: "/theme-preview" },
            { icon: Users, label: "User Management", href: "/dashboard/users" },
            { icon: ShieldCheck, label: "Permissions", href: "#" },
            { icon: Bell, label: "Notifications", href: "#" },
            { icon: Settings, label: "System Settings", href: "#" },
          ].map((item, i) => (
            <Link 
              key={i} 
              href={item.href}
              onClick={() => setActiveMenu(item.label)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors",
                activeMenu === item.label ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
            )}>
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-white/10">
          <button className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium text-white/70 hover:bg-white/5 hover:text-white transition-colors">
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-[var(--color-background)]">
        {/* Header */}
        <header className="h-16 bg-[var(--color-surface)] border-b border-[var(--color-accent)]/10 flex items-center justify-between px-8 shadow-sm">
          <button onClick={() => setSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-black/5 rounded-lg transition-colors">
            <MenuIcon className="w-5 h-5 text-[var(--color-text-secondary)]" />
          </button>
          
          <div className="flex items-center gap-4">
             <div className="text-right">
                <p className="text-sm font-bold text-[var(--color-text-primary)]">สมชาย ใจดี</p>
                <p className="text-xs text-[var(--color-text-secondary)]">Super Admin</p>
             </div>
             <div className="w-10 h-10 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center font-bold">
                SJ
             </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="p-8 overflow-y-auto">
          <div className="max-w-4xl mx-auto space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Theme & UI Preview</h1>
                <p className="text-[var(--color-text-secondary)]">ทดสอบระบบ Dynamic Theme และรูปแบบการจัดวาง Component</p>
              </div>
              <div className="flex bg-[var(--color-surface)] p-1 rounded-xl shadow-sm border border-[var(--color-accent)]/10">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => changeTheme(t.id)}
                    className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center transition-all",
                      currentTheme === t.id ? "scale-110 shadow-lg ring-2 ring-offset-2 ring-[var(--color-primary)]" : "hover:scale-105"
                    )}
                    title={t.name}
                  >
                    <div className={cn("w-6 h-6 rounded-full", t.color)} />
                  </button>
                ))}
              </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                { label: "Active Users", value: "1,248", icon: Users, color: "text-blue-600", bg: "bg-blue-100" },
                { label: "Security Alerts", value: "3", icon: ShieldCheck, color: "text-red-600", bg: "bg-red-100" },
                { label: "Storage Used", value: "85%", icon: LayoutDashboard, color: "text-amber-600", bg: "bg-amber-100" },
              ].map((stat, i) => (
                <div key={i} className="bg-[var(--color-surface)] p-6 rounded-2xl shadow-sm border border-[var(--color-accent)]/10 flex items-center gap-4">
                  <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center", stat.bg)}>
                    <stat.icon className={cn("w-6 h-6", stat.color)} />
                  </div>
                  <div>
                    <p className="text-sm text-[var(--color-text-secondary)]">{stat.label}</p>
                    <p className="text-2xl font-bold text-[var(--color-text-primary)]">{stat.value}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Table Mockup */}
            <div className="bg-[var(--color-surface)] rounded-2xl shadow-sm border border-[var(--color-accent)]/10 overflow-hidden">
              <div className="p-6 border-b border-[var(--color-accent)]/10 flex items-center justify-between">
                <h3 className="font-bold text-[var(--color-text-primary)]">Recent Activities</h3>
                <button className="text-sm font-medium text-[var(--color-primary)] hover:underline">View all</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-black/5 text-[var(--color-text-secondary)] text-xs uppercase">
                    <tr>
                      <th className="px-6 py-3 font-semibold">Activity</th>
                      <th className="px-6 py-3 font-semibold">User</th>
                      <th className="px-6 py-3 font-semibold">Status</th>
                      <th className="px-6 py-3 font-semibold">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-accent)]/5">
                    {[
                      { act: "Login Success", user: "Admin", status: "Success", time: "2 mins ago" },
                      { act: "Password Changed", user: "User-001", status: "Warning", time: "1 hour ago" },
                      { act: "Export Data", user: "Manager", status: "Success", time: "3 hours ago" },
                    ].map((row, i) => (
                      <tr key={i} className="hover:bg-black/5 transition-colors">
                        <td className="px-6 py-4 text-sm text-[var(--color-text-primary)]">{row.act}</td>
                        <td className="px-6 py-4 text-sm text-[var(--color-text-secondary)]">{row.user}</td>
                        <td className="px-6 py-4">
                           <span className={cn(
                             "px-2 py-1 rounded-full text-[10px] font-bold uppercase",
                             row.status === "Success" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                           )}>{row.status}</span>
                        </td>
                        <td className="px-6 py-4 text-sm text-[var(--color-text-secondary)]">{row.time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
