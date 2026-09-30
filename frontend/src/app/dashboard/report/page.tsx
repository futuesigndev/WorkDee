"use client"

import React from 'react'
import { BarChart2 } from 'lucide-react'

export default function ReportPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-4">
      <div className="inline-flex p-4 rounded-2xl bg-primary/5 text-primary">
        <BarChart2 size={32} />
      </div>
      <h1 className="text-3xl font-black tracking-tight text-base-content">Report</h1>
      <p className="text-base-content/50 font-medium">
        ยังไม่มีฟีเจอร์ในหมวดนี้ — จะเพิ่มเติมในงานถัดไป
      </p>
    </div>
  )
}
