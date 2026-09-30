/**
 * Product name used when nothing better is known (task 026).
 *
 * The name a person actually sees comes from Settings (`app_settings.app_name`) and is fetched by the
 * pages that display it (the login page and the dashboard shell) — `PRODUCT_NAME` is the first-paint
 * value there, and it is deliberately *not* the env value: `.env.local` still carried the old template
 * name (see the 026 report) during this task, and a shell that starts from the env value would flash
 * that name before the real one arrives. `BRAND_FALLBACK` is for the pages that never fetch the
 * setting (part B of the Thai pass), where the env value is the best information available.
 */
export const PRODUCT_NAME = 'WorkDee'

export const BRAND_FALLBACK = process.env.NEXT_PUBLIC_APP_NAME || PRODUCT_NAME
