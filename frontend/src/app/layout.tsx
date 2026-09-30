import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { cookies } from "next/headers";

const inter = Inter({ subsets: ["latin"] });

// APP_NAME อ่านจาก env (ชื่อแอปอาจต่างกันตาม environment เช่น staging vs prod).
// ค่า fallback ต้องเป็นชื่อสินค้าจริง ไม่ใช่ชื่อ template (งาน 026) — และค่าที่แสดงกับผู้ใช้
// จริง ๆ มาจาก Settings (`app_settings.app_name`) ผ่านหน้าเว็บ ไม่ใช่ค่าตรงนี้
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "WorkDee";
// DEFAULT_THEME เป็นแค่ static fallback ก่อนที่ theme จาก DB/cookie จะโหลด
// ไม่ใช่ per-environment config จึง hardcode ไว้ตรงนี้ได้
const DEFAULT_THEME = "corporate-navy";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "ระบบ HR สำหรับพนักงานและฝ่ายบุคคล ลงเวลา ยื่นคำขอ และรับการแจ้งเตือนผ่าน LINE",
  icons: {
    icon: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  // อ่าน theme จาก cookie (set โดย backend หลัง settings save)
  // ถ้าไม่มี cookie ให้ใช้ DEFAULT_THEME เป็น SSR fallback ก่อน DB โหลด
  const theme = cookieStore.get("theme")?.value || DEFAULT_THEME;

  return (
    <html lang="th" data-theme={theme}>
      <body className={`${inter.className} antialiased`}>
        {children}
      </body>
    </html>
  );
}
