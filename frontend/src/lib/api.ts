// ในฝั่ง Browser (Client-side) เราใช้ relative path เพื่อส่งคำขอผ่าน Next.js Proxy
// ป้องกันปัญหา Mixed Content (HTTPS -> HTTP) และ CORS เมื่อเปิดจากมือถือผ่าน URL ภายนอก (tunnel)
const isBrowser = typeof window !== 'undefined';
export const API_URL = isBrowser ? "" : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8019");

// Backend refresh endpoint (via the Next.js rewrite when running in the browser).
const REFRESH_PATH = `${API_URL}/api/v1/auth/refresh`;

/**
 * apiFetch — fetch wrapper ที่ auto-redirect ไป /login เมื่อ session หมดอายุ (401)
 * ใช้แทน fetch() ปกติในทุก client component ของ dashboard
 *
 * Features:
 * - ถ้า response เป็น 401 → ลอง refresh session เงียบ ๆ 1 ครั้ง แล้ว retry request เดิม 1 ครั้ง
 * - ถ้า refresh ล้มเหลว หรือ retry แล้วยัง 401 → redirect ไป /login (พร้อม ?expired=1)
 * - ถ้า response เป็น 403 → throw PermissionDeniedError (session ยังใช้ได้ แต่ไม่มีสิทธิ์)
 *   ไม่ refresh และไม่ redirect ไป /login — ให้ caller ตัดสินใจแสดงผลเอง
 * - Single-flight: 401 หลายอันพร้อมกันจะ await refresh promise เดียวกัน (Core-API rotate token ทุกครั้ง)
 * - ป้องกัน redirect loop โดย debounce ด้วย flag
 * - ส่ง credentials: 'include' เสมอ (cookie-based auth)
 */

let _isRedirectingToLogin = false;

/**
 * Custom error class สำหรับ session หมดอายุ
 * ใช้ throw แทน never-resolving promise เพื่อให้ async function ของ caller
 * ออกจาก try/catch ได้ทันที ไม่ทำให้ UI hang หรือกระพริบ
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Error class สำหรับ HTTP 403 — session ยังใช้ได้แต่ไม่มีสิทธิ์ (insufficient permission)
 * แยกจาก SessionExpiredError โดยเจตนา: การ refresh token ไม่ช่วยให้ได้สิทธิ์เพิ่ม
 * และไม่ควร redirect ไป /login (จะดูเหมือนปัญหา session ไม่ใช่ปัญหาสิทธิ์)
 * caller เป็นคนเลือก UI เอง (toast / inline message)
 */
export class PermissionDeniedError extends Error {
  constructor() {
    super('Permission denied');
    this.name = 'PermissionDeniedError';
  }
}

function showRedirectOverlay() {
  // แสดง overlay บล็อก UI ทันที ก่อน redirect จะเกิดขึ้น
  // ป้องกัน flicker จาก React re-render ระหว่างรอ navigation
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('__session-expired-overlay__');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = '__session-expired-overlay__';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(0,0,0,0.6)', 'backdrop-filter:blur(4px)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'flex-direction:column', 'gap:12px',
  ].join(';');
  overlay.innerHTML = `
    <div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite"></div>
    <p style="color:#fff;font-size:14px;font-weight:700;letter-spacing:0.05em">เซสชันหมดอายุ กำลังพาไปหน้าเข้าสู่ระบบ...</p>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(overlay);
}

function redirectToLogin() {
  if (_isRedirectingToLogin) return;
  _isRedirectingToLogin = true;
  showRedirectOverlay();
  // Hard redirect — ล้าง React state ทั้งหมด ไม่กระพริบ
  window.location.replace('/login?expired=1');
}

/**
 * Single-flight silent refresh.
 *
 * At most one POST /auth/refresh is in flight at a time; concurrent callers await the
 * same promise. This matters because Core-API rotates the refresh token on every use,
 * so two parallel refreshes would race and one would present a token Core-API has
 * already invalidated. Several dashboard screens fire multiple apiFetch calls in
 * parallel on mount, so this collision is a normal case, not an edge case.
 *
 * Uses a raw fetch (never apiFetch) so a 401 from the refresh endpoint can never
 * recurse back into this same retry logic.
 */
let _refreshPromise: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const res = await fetch(REFRESH_PATH, {
        method: 'POST',
        credentials: 'include',
      });
      return res.ok;
    } catch {
      return false;
    }
  })().finally(() => {
    _refreshPromise = null;
  });
  return _refreshPromise;
}

export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  let res = await fetch(input, {
    ...init,
    credentials: 'include',
  });

  if (res.status === 401) {
    // One silent refresh, then retry the original request exactly once.
    const refreshed = await refreshSession();
    if (!refreshed) {
      // Refresh failed: the session is really gone.
      redirectToLogin();
      // throw ทันที — ทำให้ caller ออกจาก try block และ finally จะทำงาน (เช่น setLoading(false))
      // ไม่ใช้ never-resolving promise เพราะทำให้ UI hang และ setState ค้าง
      throw new SessionExpiredError();
    }

    res = await fetch(input, {
      ...init,
      credentials: 'include',
    });

    if (res.status === 401) {
      // Refreshed fine, but the retry is still unauthorized: give up on this session.
      redirectToLogin();
      throw new SessionExpiredError();
    }
  }

  if (res.status === 403) {
    // Valid session, insufficient permission. Deliberately NOT routed through the 401
    // refresh-then-retry path: refreshing cannot grant permission, and redirecting to
    // /login would misrepresent a permissions problem as a session problem.
    throw new PermissionDeniedError();
  }

  return res;
}
