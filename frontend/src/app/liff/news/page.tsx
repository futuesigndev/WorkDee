"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Script from "next/script"
import { formatNewsDate } from "./thai-date"
import { MSG_CANNOT_CONNECT, messageForFailure, useLiffToken } from "./use-liff-token"

/**
 * "ข่าวสารองค์กร" for employees (task 039) — the page behind the hub card.
 *
 * What an employee can see here: **published news only**, newest first, filtered by category, read as
 * plain text. The API takes no employee id (the identity is the verified LINE ID token) and the list
 * carries no body, so the page never holds more than it shows.
 *
 * Two behaviours are deliberate and worth keeping:
 *
 * * **The filter lives in the URL (`?cat=<id>`).** Tapping a card pushes a real navigation, so LINE's
 *   own back arrow *and* the browser back button return to the list URL — i.e. to the same filter that
 *   was on screen, instead of a reset list. `history.replaceState` keeps that URL true while the
 *   employee switches chips; nothing is added to the history for a filter change.
 * * **"โหลดเพิ่ม" appends one page and asks for the next one by cursor.** No infinite scroll: an
 *   employee decides when to load more, and a news item published in between can neither repeat nor be
 *   skipped (the cursor walks `published_at` + `id`, which page numbers cannot do).
 */

type NewsRow = {
  id: string
  title: string
  category: string
  published_at: string | null
  preview: string
}

type CategoryChip = { id: string; name: string }
type Cursor = { before: string; before_id: string }
type Payload = { items: NewsRow[]; categories: CategoryChip[]; next: Cursor | null; page_size: number }

const MSG_LABEL = "ประกาศและข่าวของบริษัท"
const MSG_TITLE = "ข่าวสารองค์กร"
const MSG_SUBTITLE = "ข่าวจะแสดงจากใหม่ไปเก่า"
const MSG_ALL = "ทั้งหมด"
const MSG_EMPTY = "ยังไม่มีข่าวสาร"
const MSG_EMPTY_FILTER = "ไม่มีข่าวในประเภทนี้"
const MSG_MORE = "โหลดเพิ่ม"
const MSG_MORE_BUSY = "กำลังโหลด..."
const MSG_ERROR_TITLE = "ยังอ่านข่าวไม่ได้"
const MSG_RETRY = "ลองใหม่อีกครั้ง"

export default function LiffNewsPage() {
  const { stage, setStage, errorMsg, setErrorMsg, idToken, setLiffReady, retry } = useLiffToken()
  const [items, setItems] = useState<NewsRow[]>([])
  const [categories, setCategories] = useState<CategoryChip[]>([])
  const [cursor, setCursor] = useState<Cursor | null>(null)
  const [filter, setFilter] = useState("")
  const [busy, setBusy] = useState(false)
  // A failed "โหลดเพิ่ม" must not throw the list away: the message goes next to the button.
  const [moreError, setMoreError] = useState("")

  // A slower, older answer must not overwrite a newer one (the 010/036 `fetchSeq` guard): switching
  // chips quickly can otherwise paint the previous category's news under the new chip.
  const fetchSeq = useRef(0)
  // `busy` disables the button, but that only takes effect on the next render — two taps in the same
  // tick would both pass the state check and fetch the same page twice (the 036 lesson).
  const busyRef = useRef(false)

  /** The filter is kept in the URL so the detail page's Back returns to the same view. */
  const writeFilterToUrl = useCallback((categoryId: string) => {
    const url = categoryId ? `/liff/news?cat=${categoryId}` : "/liff/news"
    window.history.replaceState(null, "", url)
  }, [])

  const load = useCallback(async (token: string, categoryId: string, mode: "replace" | "append", from: Cursor | null) => {
    const seq = ++fetchSeq.current
    try {
      const params = new URLSearchParams()
      if (categoryId) params.set("category_id", categoryId)
      if (from) {
        params.set("before", from.before)
        params.set("before_id", from.before_id)
      }
      const query = params.toString()
      const res = await fetch(`/api/v1/news/me${query ? `?${query}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (seq !== fetchSeq.current) return
      if (!res.ok) {
        const message = await messageForFailure(res)
        if (mode === "append") setMoreError(message)
        else {
          setErrorMsg(message)
          setStage("error")
        }
        return
      }
      const body = (await res.json()) as Payload
      if (seq !== fetchSeq.current) return
      setItems((current) => (mode === "append" ? [...current, ...body.items] : body.items))
      setCategories(body.categories)
      setCursor(body.next)
      setMoreError("")
      setStage("ready")
    } catch {
      if (seq !== fetchSeq.current) return
      if (mode === "append") setMoreError(MSG_CANNOT_CONNECT)
      else {
        setErrorMsg(MSG_CANNOT_CONNECT)
        setStage("error")
      }
    }
  }, [setErrorMsg, setStage])

  // The first read once the LINE token exists; the filter starts from the URL so a Back from the
  // detail view lands on the list it came from. Inside a timer, because a state update straight from
  // the effect body is what the project's lint rule forbids (the locations page's debounce shape).
  useEffect(() => {
    if (!idToken) return
    const handle = setTimeout(() => {
      const wanted = new URLSearchParams(window.location.search).get("cat") ?? ""
      setFilter(wanted)
      void load(idToken, wanted, "replace", null)
    }, 0)
    return () => clearTimeout(handle)
  }, [idToken, load])

  const chooseFilter = (categoryId: string) => {
    if (!idToken || categoryId === filter) return
    if (busyRef.current) return
    setFilter(categoryId)
    writeFilterToUrl(categoryId)
    setMoreError("")
    setStage("loading")
    void load(idToken, categoryId, "replace", null)
  }

  const loadMore = () => {
    if (!idToken || !cursor || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    void load(idToken, filter, "append", cursor).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }

  const chipClass = (active: boolean) =>
    active
      ? "shrink-0 px-4 py-2 rounded-full text-xs font-black bg-[#06C755] text-white"
      : "shrink-0 px-4 py-2 rounded-full text-xs font-bold bg-base-200 text-base-content/70"

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setLiffReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
        <div className="w-full max-w-sm space-y-4 py-4">
          <div className="bg-[#06C755] rounded-3xl px-6 py-6 text-white shadow-xl">
            <p className="text-xs text-white/80">{MSG_LABEL}</p>
            <p className="font-black text-lg mt-0.5">{MSG_TITLE}</p>
            <p className="text-white/80 text-xs mt-1">{MSG_SUBTITLE}</p>
          </div>

          {/* === LOADING === */}
          {stage === "loading" && (
            <div className="bg-base-100 rounded-3xl shadow-xl p-10 text-center border border-base-300">
              <div className="w-12 h-12 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-6 h-6 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">กำลังโหลด...</p>
            </div>
          )}

          {/* === READY === */}
          {stage === "ready" && (
            <>
              {/* The chip row scrolls sideways on its own; `overflow-x-auto` on a full-width row is what
                  keeps a long category list from ever widening the page. */}
              {categories.length > 0 && (
                <div className="-mx-4 px-4 overflow-x-auto" data-filter-row="true">
                  <div className="flex gap-2 w-max pb-1">
                    <button type="button" onClick={() => chooseFilter("")} className={chipClass(filter === "")}>
                      {MSG_ALL}
                    </button>
                    {categories.map((category) => (
                      <button
                        key={category.id}
                        type="button"
                        data-category={category.id}
                        onClick={() => chooseFilter(category.id)}
                        className={chipClass(filter === category.id)}
                      >
                        {category.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {items.length === 0 && (
                <div className="bg-base-100 rounded-3xl border border-base-300 p-6 text-center" data-empty="true">
                  <p className="text-sm text-base-content/70">
                    {filter ? MSG_EMPTY_FILTER : MSG_EMPTY}
                  </p>
                </div>
              )}

              {items.map((row) => (
                <a
                  key={row.id}
                  href={`/liff/news/${row.id}`}
                  data-news-id={row.id}
                  className="block bg-base-100 rounded-3xl border border-base-300 shadow-lg px-5 py-4 space-y-2 hover:border-[#06C755] transition-all"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-700">
                      {row.category}
                    </span>
                    <span className="shrink-0 text-[11px] text-base-content/50">
                      {formatNewsDate(row.published_at)}
                    </span>
                  </div>
                  {/* A title wraps instead of being cut: employees must be able to read all of it. */}
                  <p className="font-black text-sm text-base-content break-words">{row.title}</p>
                  {row.preview && (
                    <p className="text-xs text-base-content/60 break-words">{row.preview}</p>
                  )}
                </a>
              ))}

              {cursor && (
                <>
                  {moreError && (
                    <p className="text-xs text-error text-center" data-more-error="true">
                      {moreError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={busy}
                    data-load-more="true"
                    className="w-full py-4 bg-base-200 hover:bg-base-300 disabled:opacity-50 font-bold text-sm rounded-2xl transition-all"
                  >
                    {busy ? MSG_MORE_BUSY : MSG_MORE}
                  </button>
                </>
              )}
            </>
          )}

          {/* === ERROR === */}
          {stage === "error" && (
            <div className="bg-base-100 rounded-3xl shadow-xl overflow-hidden border border-base-300">
              <div className="bg-amber-500 px-6 py-8 text-center text-white">
                <p className="text-4xl mb-2">⚠️</p>
                <p className="font-black text-base">{MSG_ERROR_TITLE}</p>
              </div>
              <div className="p-5 space-y-3">
                <p className="text-sm text-base-content/70 text-center" data-error="true">
                  {errorMsg}
                </p>
                <button
                  type="button"
                  data-retry="true"
                  onClick={() => {
                    setErrorMsg("")
                    if (idToken) {
                      // The LINE session is still good: just read again (this is also the way to
                      // refresh a list whose news HR has changed in the meantime).
                      setStage("loading")
                      void load(idToken, filter, "replace", null)
                      return
                    }
                    retry()
                  }}
                  className="w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                >
                  {MSG_RETRY}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
