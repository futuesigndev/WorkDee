"use client"

import React, { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { 
  LayoutDashboard, 
  Users, 
  Settings, 
  LogOut, 
  Menu, 
  X,
  Bell,
  ShieldCheck,
  MessageSquare,
  History,
  Circle,
  ChevronDown,
  ChevronRight,
  Globe,
  FileText,
  Database,
  Palette,
  Link2,
  Layers,
  BarChart2,
  Lock,
  Home
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { API_URL, apiFetch, SessionExpiredError } from '@/lib/api'

// Icon mapping to handle dynamic strings from DB
const IconMap: Record<string, any> = {
  LayoutDashboard,
  Users,
  ShieldCheck,
  MessageSquare,
  History,
  Settings,
  Bell,
  Globe,
  FileText,
  Database,
  Palette,
  Link2,
  Layers,
  BarChart2,
  Lock,
  Home,
};

interface MenuItem {
  id: string;
  key: string;
  label: string;
  path: string;
  icon: string;
  parent_id: string | null;
  order: number;
  children?: MenuItem[];
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

  // Responsive check
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024)
      if (window.innerWidth < 1024) setIsSidebarOpen(false)
      else setIsSidebarOpen(true)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Fetch dynamic menus — apiFetch auto-redirects to /login on 401
  useEffect(() => {
    const fetchMenus = async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/v1/auth/me/menus`);
        if (res.ok) {
          const data = await res.json();
          setMenuItems(data);
        }
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) {
          console.error('Failed to load menus', err);
        }
      } finally {
        setLoading(false)
      }
    };
    fetchMenus();
  }, []);

  // Periodic session heartbeat — ตรวจ session ทุก 2 นาที
  // ถ้า token หมดอายุระหว่างใช้งาน จะ redirect ทันที ไม่รอให้ user กดอะไร
  useEffect(() => {
    const checkSession = async () => {
      try {
        await apiFetch(`${API_URL}/api/v1/auth/me`);
      } catch (err) {
        if (err instanceof SessionExpiredError) return; // redirect already in progress
        // network error — ignore, ไม่ redirect (อาจแค่ offline ชั่วคราว)
      }
    };
    const interval = setInterval(checkSession, 2 * 60 * 1000); // 2 minutes
    return () => clearInterval(interval);
  }, []);

  const toggleExpand = (key: string) => {
    setExpandedMenus(prev => {
      // Exclusive accordion: close all others, toggle the clicked one
      const isCurrentlyOpen = prev[key]
      return isCurrentlyOpen ? {} : { [key]: true }
    })
  }

  const handleLogout = async () => {
    try {
      await apiFetch(`${API_URL}/api/v1/auth/logout`, { method: 'POST' })
    } catch (error) {
      console.error('Logout failed', error)
    } finally {
      // Hard redirect ล้าง state ทั้งหมดให้สะอาด
      window.location.replace('/login')
    }
  }

  // Grouping logic (Now handled by API, just simple map)
  const rootMenus = menuItems;

  return (
    <div className="min-h-screen bg-base-200 flex text-base-content selection:bg-primary selection:text-primary-content">
      {/* Sidebar */}
      <aside 
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-base-100 border-r border-base-200 transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 shadow-xl lg:shadow-none",
          !isSidebarOpen && "-translate-x-full"
        )}
      >
        <div className="h-full flex flex-col">
          {/* Brand */}
          <div className="p-6 pb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-primary rounded-xl flex items-center justify-center text-primary-content font-black text-xl shadow-lg shadow-primary/20">
                F
              </div>
              <span className="font-black text-xl tracking-tighter text-base-content">FutureSign</span>
            </div>
          </div>

          <div className="px-5 mb-4">
            <div className="h-px bg-base-content/5 w-full"></div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 space-y-1 overflow-y-auto custom-scrollbar">
            {loading ? (
              <div className="space-y-4 px-4 py-10 opacity-20">
                {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-10 bg-base-content/50 rounded-lg animate-pulse"></div>)}
              </div>
            ) : rootMenus.length === 0 ? (
              <div className="p-4 text-center text-xs text-base-content/30 italic">No access granted</div>
            ) : (
              rootMenus.map((item) => {
                const Icon = IconMap[item.icon] || Circle;
                const children = item.children || [];
                const hasChildren = children.length > 0;
                const isExpanded = expandedMenus[item.key];

                if (hasChildren) {
                  return (
                    <div key={item.key} className="space-y-1">
                      <button
                        onClick={() => toggleExpand(item.key)}
                        className={cn(
                          "w-full flex items-center justify-between px-3.5 py-3 rounded-xl font-bold transition-all duration-200 group text-base-content/50 hover:bg-base-200 hover:text-base-content"
                        )}
                      >
                        <div className="flex items-center gap-3.5">
                          <Icon size={18} className="opacity-70 group-hover:opacity-100" />
                          <span className="tracking-tight text-sm font-semibold">{item.label}</span>
                        </div>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      
                      {isExpanded && (
                        <div className="pl-4 space-y-1 ml-4 border-l border-base-content/5">
                          {children.map((child: any) => {
                            const ChildIcon = IconMap[child.icon] || Circle;
                            return (
                              <button
                                key={child.path}
                                onClick={() => router.push(child.path)}
                                className={cn(
                                  "w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl font-bold transition-all duration-200 group relative",
                                  pathname === child.path 
                                    ? "bg-primary/10 text-primary" 
                                    : "text-base-content/40 hover:bg-base-200 hover:text-base-content"
                                )}
                              >
                                <ChildIcon size={16} className={cn("transition-all", pathname === child.path ? "opacity-100" : "opacity-50 group-hover:opacity-100")} />
                                <span className="tracking-tight text-xs font-semibold">{child.label}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                }

                return (
                  <button
                    key={item.path}
                    onClick={() => router.push(item.path)}
                    className={cn(
                      "w-full flex items-center gap-3.5 px-3.5 py-3 rounded-xl font-bold transition-all duration-200 group relative",
                      pathname === item.path 
                        ? "bg-primary text-primary-content shadow-lg shadow-primary/30" 
                        : "text-base-content/50 hover:bg-base-200 hover:text-base-content"
                    )}
                  >
                    <Icon size={18} className={cn("transition-all duration-300", pathname === item.path ? "scale-110" : "opacity-70 group-hover:scale-110 group-hover:opacity-100")} />
                    <span className="tracking-tight text-sm font-semibold">{item.label}</span>
                    {pathname === item.path && (
                      <div className="absolute right-3.5 w-1 h-1 bg-primary-content rounded-full"></div>
                    )}
                  </button>
                )
              })
            )}
          </nav>

          {/* User Profile / Logout */}
          <div className="p-5 border-t border-base-200">
            <button 
              onClick={handleLogout}
              className="w-full flex items-center gap-3.5 px-3.5 py-3 rounded-xl font-bold text-error/80 hover:bg-error/10 hover:text-error transition-all group"
            >
              <LogOut size={18} className="group-hover:-translate-x-1 transition-transform" />
              <span className="text-sm">Sign Out</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-base-100/40 backdrop-blur-xl border-b border-base-200 flex items-center justify-between px-6 sticky top-0 z-40">
          <div className="flex items-center gap-4">
            {isMobile && (
              <button onClick={() => setIsSidebarOpen(true)} className="w-9 h-9 flex items-center justify-center bg-base-200 rounded-lg">
                <Menu size={18} />
              </button>
            )}
            <div className="flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-widest text-primary/60">Current View</span>
              <h2 className="text-lg font-black text-base-content tracking-tight">
                {menuItems.find(m => m.path === pathname)?.label || 'Dashboard'}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-base-300/50 rounded-lg border border-base-content/5">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-[10px] font-bold text-base-content/60 uppercase tracking-tighter">System Online</span>
            </div>

            <button className="w-9 h-9 flex items-center justify-center relative bg-base-300/50 rounded-lg hover:bg-base-300 transition-colors">
              <Bell size={16} className="text-base-content/60" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-primary rounded-full ring-2 ring-base-100"></span>
            </button>
            
            <div className="h-6 w-px bg-base-content/10 mx-0.5"></div>
            
            <div className="flex items-center gap-2.5 pl-1.5 group cursor-pointer">
              <div className="text-right hidden md:block">
                <div className="text-xs font-black text-base-content leading-tight">Admin User</div>
                <div className="text-[9px] font-bold text-primary uppercase tracking-widest">Internal Access</div>
              </div>
              <div className="w-9 h-9 rounded-xl bg-base-300 border border-base-content/10 flex items-center justify-center font-black text-xs text-base-content/40 group-hover:border-primary/30 transition-colors">
                AD
              </div>
            </div>
          </div>
        </header>

        {/* Page Area */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile Overlay */}
      {isMobile && isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
    </div>
  )
}
