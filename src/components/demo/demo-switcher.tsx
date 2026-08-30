/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The demo's persona and package switch.
 *
 * ── With the flag off it does not exist ───────────────────────────────────
 *
 * The first thing this returns is `null`, before it reads a cookie or imports
 * a dataset. Not `hidden`, not `display: none` — a control that is in the
 * markup and merely invisible is a control somebody eventually finds, and the
 * thing it switches is who you are signed in as.
 *
 * ── No client JavaScript ──────────────────────────────────────────────────
 *
 * Two `<form>`s of submit buttons calling server actions. That is deliberate:
 * every option is a real button, so it is reachable with Tab, activatable with
 * Enter or Space and announced by a screen reader without a single ARIA
 * attribute — and it works before hydration, which matters for the first thing
 * a visitor to a demo touches. The open/closed state is a `<details>`, which
 * the browser already implements correctly.
 *
 * ── Where it sits ─────────────────────────────────────────────────────────
 *
 * Fixed to the start edge — the right, in RTL — and lifted clear of the mobile
 * navigation bar at `bottom-28`, dropping to `bottom-4` at `lg` where that bar
 * is not rendered. Collapsed it is a pill about the size of a button; expanded
 * it is capped at the viewport width less a margin and scrolls inside itself,
 * so on a 375-pixel screen it is a corner control rather than a sheet over the
 * page.
 *
 * ── The label is not decoration ───────────────────────────────────────────
 *
 * The word דמו is on the collapsed pill and the sentence explaining that the
 * data is in memory is on the panel. Somebody screenshotting a screen from
 * this build and sending it onward must not be able to do so without the
 * caption, because these are believable Israeli names and prices and nothing
 * else on the page says they are invented.
 */

import { isDemoMode } from '@/lib/demo/flag'
import { currentDemoPersona, currentDemoPlan } from '@/lib/demo/session'
import { DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'

import { switchDemoPersonaAction, switchDemoPlanAction } from './actions'

const OPTION_BASE =
  'flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-start ' +
  'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-ring'

const OPTION_ON =
  'border-primary bg-primary-soft text-foreground cursor-default'

const OPTION_OFF =
  'border-border bg-surface text-foreground hover:border-border-strong hover:bg-muted'

export async function DemoSwitcher() {
  // Before anything else. Nothing below this line runs in a real build.
  if (!isDemoMode()) return null

  const [persona, plan] = await Promise.all([
    currentDemoPersona(),
    currentDemoPlan(),
  ])

  return (
    <details
      dir="rtl"
      className="fixed bottom-28 start-3 z-50 lg:bottom-4 lg:start-4"
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-accent-strong bg-accent-soft px-3 py-2 text-xs font-semibold text-accent-foreground shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        // `list-none` hides the marker in Firefox; this hides it in Safari.
        style={{ listStyle: 'none' }}
      >
        <span className="rounded-full bg-accent-foreground px-1.5 py-0.5 text-[0.625rem] tracking-widest text-accent-soft">
          דמו
        </span>
        <span className="max-w-[9rem] truncate">{persona.label}</span>
        <span aria-hidden="true">·</span>
        <span>{plan.label.split(' ')[0]}</span>
      </summary>

      <div className="mt-2 max-h-[70svh] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border-strong bg-surface p-3 shadow-2xl">
        <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs leading-relaxed text-accent-foreground">
          <strong className="font-semibold">זו הדגמה.</strong> כל הנתונים בדויים
          ויושבים בזיכרון בלבד — האנשים, הנכסים, ההזמנות והכסף. שום דבר כאן אינו
          לקוח אמיתי, ושום שינוי לא נשמר אחרי הפעלה מחדש של השרת.
        </p>

        {/* ------------------------------------------------------ persona */}
        <form action={switchDemoPersonaAction} className="mt-4">
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-muted-foreground">
              מי אני עכשיו
            </legend>

            <div className="flex flex-col gap-1.5">
              {DEMO_PERSONAS.map((option) => {
                const active = option.id === persona.id
                return (
                  <button
                    key={option.id}
                    type="submit"
                    name="persona"
                    value={option.id}
                    // The current persona is not a choice to make again, and a
                    // disabled control still reads its label to a screen
                    // reader — which is the whole point of leaving it in.
                    disabled={active}
                    aria-current={active ? 'true' : undefined}
                    className={`${OPTION_BASE} ${active ? OPTION_ON : OPTION_OFF}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {option.label}
                      {active ? (
                        <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.625rem] font-semibold text-primary-foreground">
                          נוכחי
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {option.summary}
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        </form>

        {/* --------------------------------------------------------- plan */}
        <form action={switchDemoPlanAction} className="mt-4">
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-muted-foreground">
              על איזו חבילה העסק נמצא
            </legend>

            <div className="flex flex-col gap-1.5">
              {DEMO_PLANS.map((option) => {
                const active = option.code === plan.code
                return (
                  <button
                    key={option.code}
                    type="submit"
                    name="plan"
                    value={option.code}
                    disabled={active}
                    aria-current={active ? 'true' : undefined}
                    className={`${OPTION_BASE} ${active ? OPTION_ON : OPTION_OFF}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {option.label}
                      {active ? (
                        <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.625rem] font-semibold text-primary-foreground">
                          נוכחית
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {option.entitlements.length} יכולות כלולות
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        </form>

        <p className="mt-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
          החלפה טוענת את המסך מחדש. ההרשאות לא נלקחות מהעוגייה — הן נגזרות מחדש
          מהחברות בארגון, מהתפקיד ומהטווח, בדיוק כמו אצל לקוח משלם.
        </p>
      </div>
    </details>
  )
}
