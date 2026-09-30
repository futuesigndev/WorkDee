"use client"

import { useEffect, useState } from "react"
import Script from "next/script"
import { useParams } from "next/navigation"
import { formatNewsDate } from "../thai-date"
import { MSG_CANNOT_CONNECT, MSG_SESSION_EXPIRED, messageForFailure, useLiffToken } from "../use-liff-token"

/**
 * One news item, read as plain text (task 039).
 *
 * This is a **separate route** (`/liff/news/<id>`) rather than a state on the list page, because that is
 * what makes the back gesture do the right thing without any code: LINE's own back arrow and the browser
 * back button both return to the previous history entry, which is the list URL *with its `?cat=` filter*.
 * It also gives an item a real URL (a refresh or a re-open from LINE lands on the same news).
 *
 * The body is rendered as text — React escapes it, there is no `dangerouslySetInnerHTML`, no Markdown and
 * no auto-linking anywhere — so a `<script>` inside a stored body shows up as those literal characters.
 * Line breaks are kept by `white-space: pre-wrap` on a plain paragraph, and the card has no height limit:
 * a 5000-character body makes the *page* scroll, never a nested scroller.
 */

type NewsItem = {
  id: string
  title: string
  category: string
  published_at: string | null
  preview: string
  body: string
}

const MSG_LABEL = "ประกาศและข่าวของบริษัท"
const MSG_TITLE = "ข่าวสารองค์กร"
const MSG_BACK = "‹ กลับไปหน้าข่าว"
const MSG_ERROR_TITLE = "อ่านข่าวนี้ไม่ได้"
const MSG_RETRY = "ลองใหม่อีกครั้ง"
const MSG_GONE = "ข่าวนี้ไม่มีให้อ่านแล้ว"

export default function LiffNewsDetailPage() {
  const params = useParams<{ id: string }>()
  const newsId = typeof params?.id === "string" ? params.id : ""
  const { stage, setStage, errorMsg, setErrorMsg, idToken, setLiffReady, retry } = useLiffToken()
  const [item, setItem] = useState<NewsItem | null>(null)

  useEffect(() => {
    if (!idToken || !newsId) return
    const handle = setTimeout(() => {
      const load = async () => {
        try {
          const res = await fetch(`/api/v1/news/me/${encodeURIComponent(newsId)}`, {
            headers: { Authorization: `Bearer ${idToken}` },
          })
          if (!res.ok) {
            setErrorMsg(await messageForFailure(res))
            setStage("error")
            return
          }
          setItem((await res.json()) as NewsItem)
          setStage("ready")
        } catch {
          setErrorMsg(MSG_CANNOT_CONNECT)
          setStage("error")
        }
      }
      void load()
    }, 0)
    return () => clearTimeout(handle)
  }, [idToken, newsId, setErrorMsg, setStage])

  const gone = errorMsg === MSG_GONE

  return (
    <>
      <Script
        src="https://static.line-scdn.net/liff/edge/2/sdk.js"
        onReady={() => setLiffReady(true)}
        strategy="afterInteractive"
      />

      <div className="min-h-screen bg-gradient-to-br from-[#06C755]/5 via-base-100 to-base-200 flex items-start justify-center p-4">
        <div className="w-full max-w-sm space-y-4 py-4">
          {/* The hub sends employees here from the news card, so this page keeps the same green header
              and puts the way back right under it (the system back gesture also works). */}
          <div className="bg-[#06C755] rounded-3xl px-6 py-6 text-white shadow-xl">
            <p className="text-xs text-white/80">{MSG_LABEL}</p>
            <p className="font-black text-lg mt-0.5">{MSG_TITLE}</p>
            {/* A real document load on purpose (`<Link>` would keep this page alive and the LIFF SDK
                would have to re-initialise inside the LINE webview — the same choice the hub's cards
                make). The rule is disabled with that reason rather than by hiding the URL. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/liff/news" className="inline-block text-white/90 text-xs mt-2 underline">
              {MSG_BACK}
            </a>
          </div>

          {stage === "loading" && (
            <div className="bg-base-100 rounded-3xl shadow-xl p-10 text-center border border-base-300">
              <div className="w-12 h-12 rounded-full bg-[#06C755]/10 flex items-center justify-center mx-auto mb-4 animate-spin">
                <div className="w-6 h-6 rounded-full border-4 border-[#06C755] border-t-transparent"></div>
              </div>
              <p className="font-bold text-base-content/70">กำลังโหลด...</p>
            </div>
          )}

          {stage === "ready" && item && (
            <article className="bg-base-100 rounded-3xl border border-base-300 shadow-lg px-5 py-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-700">
                  {item.category}
                </span>
                <span className="shrink-0 text-[11px] text-base-content/50">
                  {formatNewsDate(item.published_at)}
                </span>
              </div>
              <h1 className="font-black text-base text-base-content break-words" data-news-title="true">
                {item.title}
              </h1>
              {/* Plain text, line breaks preserved, never HTML. */}
              <p className="text-sm text-base-content/80 whitespace-pre-wrap break-words" data-news-body="true">
                {item.body}
              </p>
            </article>
          )}

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
                {gone ? (
                  // The item was withdrawn while the employee had it open (or the link is wrong): the
                  // only useful thing left is the way back to the list.
                  // eslint-disable-next-line @next/next/no-html-link-for-pages
                  <a
                    href="/liff/news"
                    data-gone="true"
                    className="block text-center w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                  >
                    {MSG_BACK}
                  </a>
                ) : (
                  <button
                    type="button"
                    data-retry="true"
                    onClick={() => {
                      setErrorMsg("")
                      if (idToken) {
                        setStage("loading")
                        const again = async () => {
                          try {
                            const res = await fetch(`/api/v1/news/me/${encodeURIComponent(newsId)}`, {
                              headers: { Authorization: `Bearer ${idToken}` },
                            })
                            if (!res.ok) {
                              setErrorMsg(await messageForFailure(res))
                              setStage("error")
                              return
                            }
                            setItem((await res.json()) as NewsItem)
                            setStage("ready")
                          } catch {
                            setErrorMsg(MSG_CANNOT_CONNECT)
                            setStage("error")
                          }
                        }
                        void again()
                        return
                      }
                      retry()
                    }}
                    className="w-full py-4 bg-base-200 hover:bg-base-300 font-bold text-sm rounded-2xl transition-all"
                  >
                    {MSG_RETRY}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* A 401 is worth saying out loud: the LINE session is what expired. */}
          {stage === "error" && errorMsg === MSG_SESSION_EXPIRED && (
            <p className="text-center text-[11px] text-base-content/40 px-4">
              ปิดหน้านี้แล้วเปิดใหม่อีกครั้งจากแชตของบริษัท
            </p>
          )}
        </div>
      </div>
    </>
  )
}
