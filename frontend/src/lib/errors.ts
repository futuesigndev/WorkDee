import { PermissionDeniedError } from '@/lib/api'

/**
 * Thai user-facing message for an insufficient-permission failure (HTTP 403).
 *
 * A 403 means the session is still valid — it is a permission problem, not an
 * expired session — so it reads deliberately differently from the /login redirect
 * that `apiFetch` performs on 401.
 */
export const PERMISSION_DENIED_MESSAGE =
  'คุณไม่มีสิทธิ์เข้าถึงส่วนนี้ กรุณาติดต่อผู้ดูแลระบบ'

/** True when `err` is the HTTP 403 error thrown by `apiFetch` (see `lib/api.ts`). */
export function isPermissionDenied(err: unknown): err is PermissionDeniedError {
  return err instanceof PermissionDeniedError
}

/**
 * User-facing text for a caught error.
 *
 * A `PermissionDeniedError` always maps to `PERMISSION_DENIED_MESSAGE`; every other
 * error falls back to the caller's existing copy verbatim, so adding the 403 branch
 * never changes what a page already shows for other failures.
 */
export function permissionErrorMessage(err: unknown, fallback: string): string {
  return isPermissionDenied(err) ? PERMISSION_DENIED_MESSAGE : fallback
}
