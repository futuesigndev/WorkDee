"use client"

import React, { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { 
  LayoutDashboard, 
  Users, 
  Settings, 
  LogOut, 
  PanelLeftClose,
  PanelLeftOpen,
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
  Briefcase,
  Lock,
  Home
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PRODUCT_NAME } from '@/lib/brand'
import { API_URL, apiFetch, SessionExpiredError } from '@/lib/api'
import { PERMISSION_DENIED_MESSAGE, isPermissionDenied } from '@/lib/errors'

// Icon mapping to handle dynamic strings from DB
const IconMap: Record<string, LucideIcon> = {
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
  Briefcase,
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

const SIDEBAR_PREF_KEY = 'dashboard-sidebar-open'

/**
 * Saved desktop sidebar preference. Anything other than an explicit "false" means expanded, so a
 * first-time visitor (nothing stored) gets the default expanded sidebar.
 */
function readSidebarPref(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PREF_KEY) !== 'false'
  } catch {
    return true // storage unavailable (private mode / disabled) — just don't persist
  }
}

function writeSidebarPref(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_PREF_KEY, String(open))
  } catch {
    // storage unavailable — the toggle still works for this session, it just isn't remembered
  }
}

/**
 * Who the shell says you are (task 023). Comes from `GET /api/v1/auth/me`, which has no permission
 * requirement of its own — an account with zero menu grants can still see its own name.
 */
interface Identity {
  employee_id: string
  full_name: string
  role_name: string
}

// Thai fallback for the card while the identity is loading or when that call fails.
const IDENTITY_FALLBACK = 'ผู้ใช้'

/**
 * Two-character avatar from a name: first letter of the first and last word ("Admin User" → "AU",
 * "นายบรรจง วงค์หลวง" → "นว"). A single word gives its first two characters. `Array.from` walks
 * code points, so a Thai combining mark can never be split off into its own "letter".
 */
function initialsOf(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('')
  return Array.from(words[0])[0] + Array.from(words[words.length - 1])[0]
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [brand, setBrand] = useState(PRODUCT_NAME)
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [menusDenied, setMenusDenied] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  // Responsive check. Also restores the saved desktop preference — localStorage can only be read
  // client-side, so this has to live in an effect (never during render) to avoid a server/client
  // hydration mismatch.
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 1024
      setIsMobile(mobile)
      // Mobile keeps its existing slide-in behaviour: it always starts closed.
      setIsSidebarOpen(mobile ? false : readSidebarPref())
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Collapse/expand the sidebar. Only the desktop preference is persisted — mobile always starts
  // closed, so remembering a state there would be meaningless.
  const toggleSidebar = () => {
    const next = !isSidebarOpen
    setIsSidebarOpen(next)
    if (!isMobile) writeSidebarPref(next)
  }

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
        if (isPermissionDenied(err)) {
          // Session is valid, but this account may not read the menu list (HTTP 403).
          setMenusDenied(true);
        } else if (!(err instanceof SessionExpiredError)) {
          console.error('Failed to load menus', err);
        }
      } finally {
        setLoading(false)
      }
    };
    fetchMenus();
  }, []);

  // The identity card. Failures are silent by design: the card falls back to "ผู้ใช้" rather than
  // taking over the screen, because a missing name never blocks the work. A 401/SessionExpired here
  // is already handled inside apiFetch (one refresh attempt, then /login).
  useEffect(() => {
    const fetchIdentity = async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/v1/auth/me`);
        if (res.ok) {
          setIdentity(await res.json());
        }
      } catch {
        // PermissionDenied / SessionExpired / network — leave the fallback in place.
      }
    };
    fetchIdentity();
  }, []);

  // The brand name. Failures are silent by design: the sidebar falls back to the product name rather
  // than showing an error, because a missing name never blocks any work.
  useEffect(() => {
    const fetchBrand = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/settings`);
        if (res.ok) {
          const data = await res.json();
          const name = typeof data?.app_name === 'string' ? data.app_name.trim() : '';
          if (name) setBrand(name);
        }
      } catch {
        // keep BRAND_FALLBACK
      }
    };
    fetchBrand();
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

  // The header title: child menus (e.g. "รายการลงเวลา") are nested under their parent, so the label
  // is looked up in both levels — otherwise every child route showed "Dashboard" here.
  const currentViewLabel =
    menuItems.flatMap((item) => [item, ...(item.children ?? [])]).find((item) => item.path === pathname)?.label
    || 'ภาพรวม';

  // Identity card values: the name (employee id when the name is empty), the role name, and initials
  // derived from whatever is displayed. Roles are stored as data ("Admin", "Supervisor", …).
  const identityName = identity?.full_name?.trim() || identity?.employee_id || IDENTITY_FALLBACK;
  const identityRole = identity?.role_name ?? '';
  const identityInitials = identity ? initialsOf(identityName) : initialsOf(IDENTITY_FALLBACK);

  return (
    <div className="min-h-screen bg-base-200 flex text-base-content selection:bg-primary selection:text-primary-content">
      {/* Sidebar */}
      <aside
        id="dashboard-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-base-100 border-r border-base-200 transition-transform duration-300 ease-in-out lg:static lg:inset-0 shadow-xl lg:shadow-none",
          // Mobile: slide out of view (existing behaviour). Desktop: drop the sidebar out of the
          // flex row entirely so <main> reclaims the full width.
          isSidebarOpen ? "lg:translate-x-0" : "-translate-x-full lg:hidden"
        )}
      >
        <div className="h-full flex flex-col">
          {/* Brand */}
          <div className="p-6 pb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 shrink-0 bg-primary rounded-xl flex items-center justify-center text-primary-content font-black text-xl shadow-lg shadow-primary/20">
                {Array.from(brand)[0]?.toUpperCase() ?? 'W'}
              </div>
              <span
                className="font-black text-xl tracking-tighter text-base-content truncate max-w-[150px]"
                title={brand}
              >
                {brand}
              </span>
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
              <div className={cn(
                "p-4 text-center text-xs",
                menusDenied ? "text-error/80 font-bold" : "text-base-content/30 italic"
              )}>
                {menusDenied ? PERMISSION_DENIED_MESSAGE : 'ยังไม่ได้รับสิทธิ์เข้าถึงเมนู'}
              </div>
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
                          {children.map((child) => {
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
              <span className="text-sm">ออกจากระบบ</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-base-100/40 backdrop-blur-xl border-b border-base-200 flex items-center justify-between px-6 sticky top-0 z-40">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={isSidebarOpen ? "ย่อแถบเมนู" : "ขยายแถบเมนู"}
              aria-expanded={isSidebarOpen}
              aria-controls="dashboard-sidebar"
              className="w-9 h-9 flex items-center justify-center bg-base-200 rounded-lg hover:bg-base-300 transition-colors"
            >
              {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            <div className="flex flex-col">
              <span className="text-[10px] font-bold text-primary/60">มุมมองปัจจุบัน</span>
              <h2 className="text-lg font-black text-base-content tracking-tight">
                {currentViewLabel}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-base-300/50 rounded-lg border border-base-content/5">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-[10px] font-bold text-base-content/60 uppercase tracking-tighter">ระบบออนไลน์</span>
            </div>

            <button className="w-9 h-9 flex items-center justify-center relative bg-base-300/50 rounded-lg hover:bg-base-300 transition-colors">
              <Bell size={16} className="text-base-content/60" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-primary rounded-full ring-2 ring-base-100"></span>
            </button>
            
            <div className="h-6 w-px bg-base-content/10 mx-0.5"></div>
            
            <div className="flex items-center gap-2.5 pl-1.5 group cursor-pointer">
              <div className="text-right hidden md:block">
                <div className="text-xs font-black text-base-content leading-tight truncate max-w-[150px]" title={identityName}>
                  {identityName}
                </div>
                <div className="text-[10px] font-bold text-primary truncate max-w-[150px]" title={identityRole}>
                  {identityRole}
                </div>
              </div>
              <div className="w-9 h-9 shrink-0 rounded-xl bg-base-300 border border-base-content/10 flex items-center justify-center font-black text-xs text-base-content/70 group-hover:border-primary/30 transition-colors">
                {identityInitials}
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
