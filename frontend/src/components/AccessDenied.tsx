'use client'

import React from 'react'
import { ShieldAlert } from 'lucide-react'
import { PERMISSION_DENIED_MESSAGE } from '@/lib/errors'

/**
 * Inline "access denied" state, rendered in place of a page whose initial data
 * fetch returned HTTP 403 (insufficient permission to view this screen at all).
 *
 * This is deliberately only used for *page-load* failures: the user cannot see the
 * screen, so an ephemeral toast would vanish and leave a blank page looking broken.
 * A 403 on an *action* the user triggers while already on the page is reported
 * through that page's own existing notification instead, leaving the page usable.
 */
export default function AccessDenied({
  message = PERMISSION_DENIED_MESSAGE,
}: {
  message?: string
}) {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="max-w-md w-full text-center bg-base-100 border border-error/20 rounded-3xl p-8 space-y-3">
        <div className="inline-flex p-3 rounded-2xl bg-error/10 text-error">
          <ShieldAlert size={28} />
        </div>
        <h2 className="text-lg font-black tracking-tight text-base-content">Access denied</h2>
        <p className="text-sm font-medium text-base-content/60">{message}</p>
      </div>
    </div>
  )
}
