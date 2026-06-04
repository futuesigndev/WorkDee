// ในฝั่ง Browser (Client-side) เราใช้ relative path เพื่อส่งคำขอผ่าน Next.js Proxy
// ป้องกันปัญหา Mixed Content (HTTPS -> HTTP) และ CORS เมื่อเปิดในมือถือผ่าน ngrok
const isBrowser = typeof window !== 'undefined';
export const API_URL = isBrowser ? "" : (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8011");
