'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The two cookies the demo is steered by.
 *
 * ── Why these are actions and not an API route ────────────────────────────
 *
 * The switcher is a `<form>` with submit buttons and no client JavaScript, so
 * it works with the keyboard, works before hydration, and works with
 * JavaScript disabled. A route handler would need a fetch to call it, which
 * is a client component and a hydration boundary for a control whose entire
 * job is to set a cookie and re-render.
 *
 * ── Why they refuse when the flag is off ──────────────────────────────────
 *
 * `isDemoMode()` is checked here as well as in the component that renders the
 * form. That is not belt and braces for its own sake: a server action is a
 * public endpoint, addressable by its id, and a production build that
 * accidentally shipped this module must not have a live endpoint that writes
 * an identity cookie. The component decides whether to *offer* the switch; the
 * action decides whether to *perform* it, and the second decision is the one
 * that matters.
 *
 * The cookies are `httpOnly`: nothing in the browser reads them, and the two
 * things that do — `currentDemoPersona` and `currentDemoPlan` — are server
 * only. A demo is not a security boundary, but a cookie that no client needs
 * is a cookie no client should be able to read.
 */

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'

import { DEMO_PERSONA_COOKIE, DEMO_PLAN_COOKIE, isDemoMode } from '@/lib/demo'

/** A year. The demo is a place somebody comes back to, not a session. */
const MAX_AGE = 60 * 60 * 24 * 365

async function remember(name: string, value: string): Promise<void> {
  const store = await cookies()
  store.set(name, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE,
  })
}

/**
 * Re-render everything under the app shell.
 *
 * Both cookies change who the person is and what their organization is paying
 * for, and the shell, the menu and the page all derive from that. Revalidating
 * the layout rather than the page is the difference between the sidebar
 * updating and the sidebar quietly showing the previous persona's menu.
 */
function reload(): void {
  revalidatePath('/', 'layout')
}

/** Act as somebody else. An unknown id falls back in `resolvePersona`. */
export async function switchDemoPersonaAction(
  formData: FormData,
): Promise<void> {
  if (!isDemoMode()) return

  const persona = formData.get('persona')
  if (typeof persona !== 'string' || persona.length === 0) return

  await remember(DEMO_PERSONA_COOKIE, persona)
  reload()
}

/** Move the organization to another package. */
export async function switchDemoPlanAction(formData: FormData): Promise<void> {
  if (!isDemoMode()) return

  const plan = formData.get('plan')
  if (typeof plan !== 'string' || plan.length === 0) return

  await remember(DEMO_PLAN_COOKIE, plan)
  reload()
}
