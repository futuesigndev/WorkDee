import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// NOTE: ไฟล์นี้ถูก migrate จาก middleware.ts → proxy.ts
// ตาม Next.js 16+ canary convention (middleware → proxy)
export function proxy(request: NextRequest) {
  const token = request.cookies.get('access_token')?.value
  const isLoginPage = request.nextUrl.pathname === '/login'
  const isLiffPage = request.nextUrl.pathname.startsWith('/liff')

  // Bypass auth check for LIFF pages (so employees can register without logging into the dashboard)
  if (isLiffPage) {
    return NextResponse.next()
  }

  // 1. ถ้าไม่มี token และไม่ได้อยู่ที่หน้า login → redirect ไป /login
  if (!token && !isLoginPage) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // 2. ถ้า login อยู่แล้วและพยายามเข้าหน้า login → redirect ไป /dashboard
  if (token && isLoginPage) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}
