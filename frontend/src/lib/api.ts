// ในฝั่ง Browser (Client-side) เราใช้ relative path เพื่อส่งคำขอผ่าน Next.js Proxy
// ป้องกันปัญหา Mixed Content (HTTPS -> HTTP) และ CORS เมื่อเปิดในมือถือผ่าน ngrok
const isBrowser = typeof window !== 'undefined';
export const API_URL = isBrowser ? "" : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8011");

/**
 * apiFetch — fetch wrapper ที่ auto-redirect ไป /login เมื่อ session หมดอายุ (401)
 * ใช้แทน fetch() ปกติในทุก client component ของ dashboard
 *
 * Features:
 * - ถ้า response เป็น 401 → redirect ไป /login ทันที (พร้อม ?expired=1)
 * - ป้องกัน redirect loop โดย debounce ด้วย flag
 * - ส่ง credentials: 'include' เสมอ (cookie-based auth)
 */

let _isRedirectingToLogin = false;

function redirectToLogin() {
  if (_isRedirectingToLogin) return;
  _isRedirectingToLogin = true;
  // Hard redirect — ล้าง React state ทั้งหมด ไม่กระพริบ
  window.location.replace('/login?expired=1');
}

export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    credentials: 'include',
  });

  if (res.status === 401) {
    redirectToLogin();
    // Return a never-resolving promise เพื่อไม่ให้ caller ทำงานต่อระหว่าง redirect
    return new Promise(() => {});
  }

  return res;
}
