'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { AutopilotCapabilityState } from '@/lib/contracts/states'

/**
 * The control that changes one customer's Autopilot standing.
 *
 * ══ ONE FORM, BECAUSE IT IS ONE DECISION ══════════════════════════════════
 *
 * There is no separate control for the entitlement. Choosing `enabled` grants
 * it; choosing `suspended` withdraws it; the operation behind this form writes
 * both in one call. A screen with two switches is a screen where somebody
 * flips one — see the header of `src/lib/platform/autopilot.ts`.
 *
 * ── Why this is a Client Component ────────────────────────────────────────
 *
 * Exactly one reason: the note is required for `suspended` and `disabled` and
 * for nothing else, and the end date is required for `trial` and for nothing
 * else. Making the browser say so needs the selected value while the person is
 * still typing, which is state. Nothing else here is interactive, and the
 * component holds no data of its own — every option, label and rule arrives as
 * a serialisable prop from the server, so it imports nothing that could reach
 * the database.
 *
 * ── The browser is the third place that says no, not the first ────────────
 *
 * `required` here is a courtesy to whoever is typing. The refusals that count
 * are `note_required` and `trial_end_required` in the operation's `rule`,
 * which run before anything is written, and the CHECK constraints
 * `autopilot_capability_suspension_has_note` and
 * `autopilot_capability_trial_has_end` under those. Three statements of one
 * rule; the browser's is the least important and the most useful.
 */

export interface CapabilityStateOption {
  value: AutopilotCapabilityState
  label: string
  meaning: string
  /** The database refuses this state without a note. So does this form. */
  noteRequired: boolean
  /** The database refuses this state without an end date. So does this form. */
  trialEndRequired: boolean
}

export function CapabilityControl({
  organizationId,
  currentState,
  currentTrialEndsAt,
  currentActionLimit,
  currentNote,
  options,
  action,
}: {
  organizationId: string
  currentState: AutopilotCapabilityState
  /** `YYYY-MM-DD`, for the date input. */
  currentTrialEndsAt: string | null
  currentActionLimit: number | null
  currentNote: string | null
  options: readonly CapabilityStateOption[]
  action: (form: FormData) => Promise<void>
}) {
  // Held as a plain string: the value arrives from a DOM event, and narrowing
  // it here would be a runtime claim about a form field. The lookup below
  // decides everything, and an unrecognised value simply matches no option.
  const [state, setState] = useState<string>(currentState)
  const chosen = options.find((option) => option.value === state)

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft"
    >
      <input type="hidden" name="organizationId" value={organizationId} />

      <div>
        <h2 className="font-display text-lg font-bold tracking-tight">
          שינוי מצב היכולת
        </h2>
        <p className="text-sm text-muted-foreground">
          שמירה כותבת שני דברים בפעולה אחת: את שורת{' '}
          <code dir="ltr">autopilot_capability</code>, שמסבירה למה, ואת ההרשאה{' '}
          <code dir="ltr">autopilot</code> במנוי, שהיא מה שהמוצר קורא בפועל. אין
          כאן מתג נפרד להרשאה, כדי שלא יהיה מצב שבו אחד מהשניים זז והשני לא.
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">מצב</span>
        <select
          name="state"
          value={state}
          onChange={(event) => setState(event.target.value)}
          className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {chosen && (
          <span className="text-xs text-muted-foreground">
            {chosen.meaning}
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">
          תאריך סיום התנסות
          {chosen?.trialEndRequired ? ' (חובה בהתנסות)' : ' (רק בהתנסות)'}
        </span>
        <input
          type="date"
          name="trialEndsAt"
          dir="ltr"
          required={chosen?.trialEndRequired ?? false}
          disabled={!(chosen?.trialEndRequired ?? false)}
          defaultValue={currentTrialEndsAt ?? ''}
          className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <span className="text-xs text-muted-foreground">
          התנסות בלי תאריך סיום היא שכבה חינמית שאיש לא החליט למכור, ולכן היא
          נדחית. שימו לב: בתאריך הזה ההרשאה עצמה אינה נעלמת — היא נשארת עד
          שמישהו משנה את המצב כאן. המסך מציג התנסויות שפג תוקפן כרשימת עבודה.
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">תקרת פעולות אוטומטיות ליום</span>
        <input
          type="number"
          name="actionLimit"
          min={1}
          step={1}
          dir="ltr"
          defaultValue={currentActionLimit ?? ''}
          className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <span className="text-xs text-muted-foreground">
          שדה ריק פירושו שאין תקרה — לא אפס.
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">
          הערה{chosen?.noteRequired ? ' (חובה בהשהיה או בביטול)' : ' (רשות)'}
        </span>
        <textarea
          name="note"
          rows={2}
          required={chosen?.noteRequired ?? false}
          defaultValue={currentNote ?? ''}
          placeholder={
            chosen?.noteRequired
              ? 'לדוגמה: שלוש פעולות אוטומטיות נכשלו ברצף, קריאה #5120'
              : ''
          }
          className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <span className="text-xs text-muted-foreground">
          ההערה נשמרת על השורה ומוצגת בקונסולה. מישהו שולל יכולת מלקוח משלם,
          והסיבה צריכה לשרוד את מי שהחליט עליה.
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">
          נימוק (חובה, ונרשם ביומן הביקורת של הלקוח)
        </span>
        <textarea
          name="reason"
          required
          rows={2}
          placeholder="לדוגמה: הלקוח רכש את התוסף, עסקה #8891"
          className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>

      <div>
        <Button
          type="submit"
          variant={chosen?.noteRequired ? 'danger' : 'primary'}
        >
          שמירת המצב וההרשאה
        </Button>
      </div>
    </form>
  )
}

/** The panel a colleague without the grant sees instead of the form. */
export function CapabilityControlUnavailable() {
  return (
    <section className="rounded-xl border border-border bg-surface p-5 text-sm shadow-soft">
      <h2 className="mb-1 font-display text-lg font-bold tracking-tight">
        שינוי מצב היכולת
      </h2>
      <p className="rounded-lg border border-border bg-muted px-4 py-3">
        התפקיד שלך אינו כולל <code dir="ltr">platform.organization.manage</code>
        , ולכן אי אפשר לשנות מכאן את מצב הטייס האוטומטי. המסך מוצג ולא מוסתר:
        היכולת קיימת במוצר, היא פשוט לא שלך. הפעולה בודקת את ההרשאה שוב בעצמה,
        וכך גם המדיניות במסד הנתונים.
      </p>
    </section>
  )
}
