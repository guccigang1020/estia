'use client'

/**
 * Moving a stocktake from one stage to the next.
 *
 * ── Each button says what it will do before it does it ────────────────────
 *
 * Starting a count freezes what the system believes; reconciling compares;
 * closing ends it. None of those is obvious from a verb alone, so each button
 * carries the sentence beside it rather than in a tooltip nobody opens on a
 * phone in a linen cupboard.
 *
 * ── Closing asks for a reason only when it matters ────────────────────────
 *
 * The operation demands a stated reason only when differences remain
 * unexplained. So does this form: a clean count closes with one press, and a
 * count with eleven unaccounted towels asks what was decided. Demanding a
 * sentence every time is how the sentence becomes "ok".
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import type { CountSessionStatus } from '@/lib/inventory/counts'

import {
  cancelCountSessionAction,
  closeCountSessionAction,
  reconcileCountAction,
  startCountingAction,
} from '../_lib/actions'

export interface SessionActionsProps {
  sessionId: string
  status: CountSessionStatus
  blind: boolean
  /** How many differences still have no explanation. Drives the reason box. */
  unexplained: number
}

export function SessionActions({
  sessionId,
  status,
  blind,
  unexplained,
}: SessionActionsProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)

  function run(
    work: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        setFailure(null)
        setReason('')
        setCancelling(false)
        router.refresh()
        return
      }
      setFailure(result.error?.message ?? 'הפעולה לא בוצעה.')
    })
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-4 shadow-soft">
      {failure !== null && (
        <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {failure}
        </p>
      )}

      {status === 'open' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            התחלת הספירה מצלמת את הכמויות שהמערכת מכירה כרגע. ההשוואה תיעשה מול
            הצילום הזה ולא מול המצב בסוף הספירה.
            {blind
              ? ' הצילום לא ייחשף לסופר — זו ספירה עיוורת.'
              : ' הצילום יוצג לסופר לפי בחירת הארגון.'}
          </p>
          <div>
            <Button
              disabled={pending}
              onClick={() => run(() => startCountingAction({ sessionId }))}
            >
              {pending ? 'מתחיל…' : 'התחל ספירה'}
            </Button>
          </div>
        </div>
      )}

      {status === 'counting' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            ההתאמה משווה את מה שנספר לצילום ורושמת כל הפרש. פריט שלא נספר לא
            ייחשב כחסר — הוא ידווח כ״לא נספר״.
          </p>
          <div>
            <Button
              disabled={pending}
              onClick={() => run(() => reconcileCountAction({ sessionId }))}
            >
              {pending ? 'משווה…' : 'סיים ספירה והשווה'}
            </Button>
          </div>
        </div>
      )}

      {status === 'reconciling' && (
        <div className="flex flex-col gap-3">
          {unexplained > 0 ? (
            <Field
              label="מה הוחלט לגבי ההפרשים שלא הוסברו"
              description={`נותרו ${unexplained} הפרשים ללא הסבר. אפשר לסגור כך — הפרש בלי הסבר נשאר בלי הסבר — אבל צריך לכתוב מה נבדק.`}
            >
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
              />
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">
              כל ההפרשים סווגו. סגירת הספירה מעדכנת את מועד הספירה האחרון על
              הפריטים שנספרו בפועל.
            </p>
          )}
          <div>
            <Button
              disabled={pending}
              onClick={() =>
                run(() =>
                  closeCountSessionAction({
                    sessionId,
                    reason: reason.trim().length === 0 ? null : reason.trim(),
                  }),
                )
              }
            >
              {pending ? 'סוגר…' : 'סגור ספירה'}
            </Button>
          </div>
        </div>
      )}

      {status !== 'closed' && status !== 'cancelled' && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {!cancelling ? (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCancelling(true)}
              >
                בטל את הספירה
              </Button>
            </div>
          ) : (
            <>
              <Field
                label="למה הספירה מופסקת"
                description="ביטול אינו רושם שום תנועת מלאי. המספרים שנספרו נשמרים כרשומה בלבד."
                required
              >
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={pending || reason.trim().length === 0}
                  onClick={() =>
                    run(() =>
                      cancelCountSessionAction({
                        sessionId,
                        reason: reason.trim(),
                      }),
                    )
                  }
                >
                  {pending ? 'מבטל…' : 'אשר ביטול'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCancelling(false)}
                >
                  חזרה
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
