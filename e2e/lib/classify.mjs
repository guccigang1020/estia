/**
 * Turning one response into one classification.
 *
 * ── Why the status code is not the answer ─────────────────────────────────
 *
 * The app shell streams. Next flushes the sidebar and the persona switcher
 * immediately, then renders the page underneath — so a route that *refuses*
 * still returns `200`, and the refusal arrives later in the same body as
 *
 *     <meta id="__next-page-redirect" http-equiv="refresh"
 *           content="1;url=/dashboard?denied=invoice.view&reason=…">
 *
 * A sweep that read `response.status` would have recorded 392 OKs and found
 * nothing. Every verdict below is therefore taken from the body.
 */

/** Visible text: scripts and tags removed, whitespace collapsed. */
export function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The streamed refusal, if the body carries one. */
export function streamedRedirect(html) {
  const m = html.match(
    /<meta id="__next-page-redirect"[^>]*content="[^;]*;url=([^"]+)"/,
  )
  if (!m) return null
  const url = m[1].replace(/&amp;/g, '&')
  const denied = url.match(/[?&]denied=([^&]+)/)
  const reason = url.match(/[?&]reason=([^&]+)/)
  return {
    url,
    denied: denied ? decodeURIComponent(denied[1]) : null,
    reason: reason ? decodeURIComponent(reason[1]) : null,
  }
}

/** Titles the product uses when a screen is legitimately empty. */
const EMPTY_TITLES = [
  'עוד אין הזמנות ביומן',
  'עוד לא הוספת נכס',
  'לנכס הזה עוד אין יחידות',
  'עוד לא נרשמו אורחים',
  'אתה עדיין לבד בארגון',
  'עוד לא הופקו חשבוניות',
  'אין משימות פתוחות',
  'אין שיחות פתוחות',
]

/** Titles the product uses when something went wrong. */
const ERROR_TITLES = [
  'אין חיבור לשרת',
  'השרת לא הגיב בזמן',
  'החיבור למערכת פג',
  'אין לך הרשאה לפעולה הזאת',
  'הפריט לא נמצא',
  'הדף לא נמצא',
]

export function classify(response, { pageExistsOnDisk = true } = {}) {
  const { status, body } = response
  const text = visibleText(body)
  const redirect = streamedRedirect(body)

  const evidence = { text, redirect, status, length: body.length }

  if (status >= 500)
    return { verdict: 'BROKEN', why: `HTTP ${status}`, evidence }

  if (status === 404) {
    return {
      verdict: pageExistsOnDisk ? 'BROKEN' : 'ABSENT',
      why: `HTTP 404${pageExistsOnDisk ? ' though a page.tsx exists on disk' : ''}`,
      evidence,
    }
  }

  if (redirect) {
    if (redirect.denied) {
      return {
        verdict: 'REFUSED',
        why: `redirected to ${redirect.url}`,
        denied: redirect.denied,
        reason: redirect.reason,
        evidence,
      }
    }
    return {
      verdict: 'REFUSED',
      why: `redirected to ${redirect.url} with no stated reason`,
      statedReason: false,
      evidence,
    }
  }

  const errorTitle = ERROR_TITLES.find((t) => text.includes(t))
  if (errorTitle) {
    return { verdict: 'BROKEN', why: `error screen: ${errorTitle}`, evidence }
  }

  // A dev-mode server error that escapes the shell leaves the page region
  // empty and the overlay payload in the body.
  if (
    body.includes('__next_error__') &&
    !body.includes('__next-page-redirect')
  ) {
    return { verdict: 'BROKEN', why: 'next dev error boundary', evidence }
  }

  const emptyTitle = EMPTY_TITLES.find((t) => text.includes(t))
  if (emptyTitle) {
    return {
      verdict: 'EMPTY_HONEST',
      why: `empty state: ${emptyTitle}`,
      evidence,
    }
  }

  return { verdict: 'OK', why: `HTTP ${status}`, evidence }
}
