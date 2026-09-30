"use client"

import React from 'react'
import { Link2 } from 'lucide-react'

export default function ConfigAppPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-4">
      <div className="inline-flex p-4 rounded-2xl bg-primary/5 text-primary">
        <Link2 size={32} />
      </div>
      <h1 className="text-3xl font-black tracking-tight text-base-content">Config App</h1>
      <p className="text-base-content/50 font-medium">
        ยังไม่มีฟีเจอร์ในหมวดนี้ — จะเพิ่มเติมในงานถัดไป
      </p>
    </div>
  )
}
