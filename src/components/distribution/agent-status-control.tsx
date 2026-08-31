'use client'

/**
 * Suspending an agent, reinstating one, and removing one.
 *
 * ── Why this control is on the list screen and not buried ─────────────────
 *
 * `lifecycle.ts` states the requirement in one line: suspension is the button
 * an owner presses **the moment they discover something**, and a mechanism that
 * takes effect "at their next login" is a mechanism that was not there when it
 * was needed. A control that takes four navigations to reach has the same
 * defect for a human reason rather than a technical one, so it sits on the row.
 *
 * ── It takes effect on the next request, and the copy says so ─────────────
 *
 * Not as reassurance — as a fact the reader can check. An `Actor` is rebuilt
 * from the database on every request and `authorize()` refuses a membership
 * that is not `active` before it looks at a single grant; there is no
 * permission cache and nothing durable is held in the agent's browser. So the
 * screen the suspended agent is looking at right now is only a picture, and its
 * next request is judged against the row as it is now. `router.refresh()` after
 * a success is what makes *this* screen agree, and the confirmation text says
 * what happened rather than "נשמר".
 *
 * ── The reason is collected before the round trip ─────────────────────────
 *
 * `agent.set_status` declares `requiresReason: true`, so the server refuses a
 * blank one whatever this form does. The field is here so the person is asked
 * first rather than after a failed submit — the same decision `CancelBooking`
 * made, and for the same reason: the sentence is read six months later by
 * somebody trying to find out why a seller was blocked.
 *
 * ── Nothing is deleted, and the dialog says that too ──────────────────────
 *
 * The domain returns `PRESERVED_ON_REMOVAL` from every status change, and the
 * dialog names it: bookings, commissions, attribution and the audit trail
 * survive. An owner hesitating over "remove" because they think it erases the
 * money they still owe is an owner who leaves a compromised account open.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { setAgentStatusAction } from '@/app/(app)/agents/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { fromSafeError } from '@/components/states/error-copy'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { PRESERVED_ON_REMOVAL } from '@/lib/agents'
import type { MembershipStatus } from '@/lib/authz/can'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

/**
 * What survives, in Hebrew, keyed by the domain's own list.
 *
 * A total `Record` over `PRESERVED_ON_REMOVAL`, so a fifth thing added to that
 * list in `lifecycle.ts` fails the typecheck here rather than quietly dropping
 * out of the sentence an owner reads before they press a destructive button.
 */
const PRESERVED_LABEL: Record<(typeof PRESERVED_ON_REMOVAL)[number], string> = {
  bookings: 'ההזמנות',
  commissions: 'העמלות',
  audit_events: 'יומן הביקורת',
  attribution: 'הייחוס',
}

const PRESERVED_SENTENCE = PRESERVED_ON_REMOVAL.map(
  (key) => PRESERVED_LABEL[key],
).join(', ')

/**
 * The moves this control offers, and the ones it does not.
 *
 * `canChangeAgentStatus` in the domain is the authority and refuses everything
 * else; this is the subset that has a button. `invited → active` and
 * `pending → active` are absent on purpose — an agent becomes active by
 * accepting their invitation and verifying their number, and a button that
 * skipped that would be an owner activating a telephone number nobody proved.
 */
type Move = { to: MembershipStatus; label: string; danger: boolean }

const MOVES: Partial<Record<MembershipStatus, readonly Move[]>> = {
  active: [
    { to: 'suspended', label: 'השעה את הסוכן', danger: true },
    { to: 'removed', label: 'הסר מרשת הסוכנים', danger: true },
  ],
  suspended: [
    { to: 'active', label: 'החזר לפעילות', danger: false },
    { to: 'removed', label: 'הסר מרשת הסוכנים', danger: true },
  ],
  removed: [{ to: 'active', label: 'החזר לפעילות', danger: false }],
  invited: [{ to: 'removed', label: 'בטל את ההזמנה', danger: true }],
  pending: [{ to: 'removed', label: 'בטל את ההזמנה', danger: true }],
}

const CONSEQUENCE: Partial<Record<MembershipStatus, string>> = {
  suspended:
    'הגישה נחסמת מיד: הבקשה הבאה של הסוכן — גם מהמסך שפתוח לו כרגע — תיבדק מול השורה כפי שהיא עכשיו ותסורב. השריונים הפתוחים שלו נחסמים גם הם.',
  removed:
    'הסוכן מפסיק להיות רשום בעסק הזה. אפשר להחזיר אותו בהמשך, וההיסטוריה שלו תחזור איתו.',
  active:
    'הגישה נפתחת מחדש בבקשה הבאה של הסוכן, לפי אותן דרגות הרשאה שהיו לו קודם.',
}

export function AgentStatusControl({
  agentUserId,
  version,
  status,
  displayName,
  phoneE164,
}: {
  agentUserId: string
  version: number
  status: MembershipStatus
  displayName: string | null
  phoneE164: string | null
}) {
  const router = useRouter()
  const [pendingMove, setPendingMove] = useState<Move | null>(null)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const moves = MOVES[status] ?? []
  const reasonMissing = reason.trim().length === 0
  const who = displayName ?? phoneE164 ?? 'הסוכן'

  if (moves.length === 0) return null

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="סיבה"
        description="נשמרת ביומן הביקורת. כל שינוי מצב של סוכן מחייב סיבה — היא מה שעונה בעוד חצי שנה על השאלה למה החשבון הזה נחסם."
        required
        error={
          touched && reasonMissing
            ? 'שינוי מצב של סוכן מחייב ציון סיבה.'
            : undefined
        }
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
          rows={2}
          placeholder="למשל: התגלה שהעביר מחירי נטו למתחרה"
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        {moves.map((move) => (
          <Button
            key={move.to}
            size="sm"
            variant={move.danger ? 'danger' : 'secondary'}
            disabled={reasonMissing}
            onClick={() => {
              setTouched(true)
              if (reasonMissing) return
              setFailure(null)
              setDone(null)
              setPendingMove(move)
            }}
          >
            {move.label}
          </Button>
        ))}
      </div>

      {failure && <ActionError error={failure} />}

      {done && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          {done}
        </p>
      )}

      <ConfirmDialog
        open={pendingMove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null)
        }}
        title={pendingMove?.label ?? ''}
        description={
          <>
            {who}: {CONSEQUENCE[pendingMove?.to ?? 'active']}
            <br />
            <br />
            לא נמחק דבר — {PRESERVED_SENTENCE} נשמרים במלואם. סוכן מושעה עדיין
            זכאי לעמלות על שהיות שטרם התקיימו.
          </>
        }
        confirmLabel={pendingMove?.label ?? ''}
        cancelLabel="בטל"
        pendingLabel="מעדכן…"
        onConfirm={async () => {
          if (!pendingMove) return

          const result = await setAgentStatusAction({
            agentUserId,
            to: pendingMove.to,
            version,
            reason: reason.trim(),
            displayName,
            phoneE164,
          })

          if (!result.ok) {
            setFailure(result.error)
            // Rethrown so the dialog stays open and reports it, rather than
            // closing on a failure and looking like it worked.
            throw result.error
          }

          // The domain's own Hebrew sentence, not a second one written here.
          setDone(result.data.summary)
          setReason('')
          setTouched(false)
          setPendingMove(null)
          router.refresh()
        }}
        toError={(cause) =>
          isSafeErrorBody(cause)
            ? fromSafeError(cause)
            : fromSafeError({
                code: 'internal_error',
                message:
                  'שינוי מצב הסוכן לא הושלם ואנחנו לא יודעים לסווג את הסיבה.',
                dataMessage:
                  'לא ידוע אם השינוי נשמר. רענן את המסך ובדוק את מצב הסוכן לפני ניסיון נוסף — סוכן שנשאר פעיל בטעות הוא סיכון, לא אי־נוחות.',
                retryMessage: 'ניסיון חוזר לא יעזור עד שהסיבה תתברר.',
                dataOutcome: 'unknown',
                retryable: false,
                correlationId: '',
              })
        }
      />
    </div>
  )
}

function isSafeErrorBody(value: unknown): value is SafeErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'dataOutcome' in value
  )
}
