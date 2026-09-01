'use client'

/**
 * The two-person split, on screen.
 *
 * ── What this control is actually for ─────────────────────────────────────
 *
 * Sending is the one act in this module that leaves the organization: a message
 * in the business's name to a company with no relationship to the guest. The
 * frozen contract defaults `LAUNDRY_DISPATCH_MODES` to `approval_required` for
 * that reason, and this panel is what that default looks like to two different
 * people.
 *
 * A housekeeping supervisor holds `laundry.order_create`. They see "raise for
 * approval" and no send button — not a disabled one, which reads as a fault
 * with their account, but a sentence saying who sends it.
 *
 * A manager holds `laundry.order_send`. They see the exact message that will
 * go, and a confirm.
 *
 * ── The message is read-only, and that is deliberate ──────────────────────
 *
 * It is rendered on the server from the order and re-rendered there again at
 * the moment of sending; the form posts no body. A textarea here would be an
 * attacker-controlled field on the one request that talks to an outside party
 * in the organization's name — the guest's name and telephone number that the
 * whole of `message.ts` exists to keep out would be one paste away. Anything
 * the provider genuinely needs to be told goes in `providerNotes`, which is
 * reviewed and which the renderer includes.
 *
 * ── Imports ───────────────────────────────────────────────────────────────
 *
 * The action, the UI primitives and one erased type. Never `@/lib/laundry` —
 * see `adjust-line-form.tsx` and `client-safety.test.ts`.
 */

import { useActionState } from 'react'

import { ActionError } from '@/components/booking/action-error'
import { SubmitButton } from '@/components/ui/async-action'
import { Badge } from '@/components/ui/badge'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

type Result<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type SendOrderPanelProps = {
  orderId: string
  /** Rendered on the server from the order. Shown, never posted back. */
  preview: string
  channel: string
  channelLabel: string
  /** Hebrew label for the dispatch mode in force. */
  dispatchLabel: string
  /** `approval_required` and still a draft: somebody must raise it first. */
  needsApproval: boolean
  alreadySent: boolean
  /** Holds `laundry.order_create`. May raise it. */
  mayRaise: boolean
  /** Holds `laundry.order_send`. May talk to the provider. */
  maySend: boolean
  /** Present only when there is a provider to send to. */
  providerName: string | null
  sendAction: (
    orderId: string,
    formData: FormData,
  ) => Promise<Result<{ id: string; sentAt: string }>>
  raiseAction: (
    orderId: string,
    formData: FormData,
  ) => Promise<Result<{ id: string; status: string }>>
  version: number
}

export function SendOrderPanel({
  orderId,
  preview,
  channel,
  channelLabel,
  dispatchLabel,
  needsApproval,
  alreadySent,
  mayRaise,
  maySend,
  providerName,
  sendAction,
  raiseAction,
  version,
}: SendOrderPanelProps) {
  const [sendState, send] = useActionState(
    async (_p: Result<{ id: string; sentAt: string }> | null, f: FormData) =>
      sendAction(orderId, f),
    null,
  )

  const [raiseState, raise] = useActionState(
    async (_p: Result<{ id: string; status: string }> | null, f: FormData) =>
      raiseAction(orderId, f),
    null,
  )

  // An internal batch has nobody to send to. Saying so is better than a
  // disabled button that looks like a permission problem.
  if (providerName === null) {
    return (
      <Panel title="שליחה">
        <p className="text-sm text-muted-foreground">
          זהו מחזור כביסה פנימי ואין ספק לשלוח אליו. העבודה מתבצעת בבית.
        </p>
      </Panel>
    )
  }

  if (alreadySent) {
    return (
      <Panel title="שליחה">
        <Badge tone="brand">נשלח</Badge>
        <p className="text-sm text-muted-foreground">
          ההזמנה כבר נשלחה ל{providerName}. שליחה חוזרת עלולה להביא רכב נוסף —
          לעדכון, צור קשר ישירות.
        </p>
      </Panel>
    )
  }

  return (
    <Panel title="שליחה לספק">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge>{dispatchLabel}</Badge>
        <span>
          יעד: {providerName} · {channelLabel}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          ההודעה שתישלח — בדיוק כפי שהיא
        </span>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm text-foreground">
          {preview}
        </pre>
        <p className="text-xs text-muted-foreground">
          הנוסח נוצר מההזמנה ואינו ניתן לעריכה כאן. אין בו שם אורח, טלפון, מחיר,
          מצב תשלום או סוכן. הערה לספק נכתבת בשדה הייעודי.
        </p>
      </div>

      {/* Step one, for whoever raises the run. */}
      {needsApproval && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          {mayRaise ? (
            <form action={raise} className="flex flex-col gap-2">
              <input type="hidden" name="version" value={version} />
              <p className="text-sm text-muted-foreground">
                ההגדרה דורשת אישור לפני שליחה. העברה לאישור אינה יוצרת קשר עם
                הספק.
              </p>
              {raiseState !== null && !raiseState.ok && (
                <ActionError error={raiseState.error} />
              )}
              {raiseState !== null && raiseState.ok && (
                <p role="status" className="text-xs font-semibold text-success">
                  ההזמנה הועברה לאישור.
                </p>
              )}
              <div>
                <SubmitButton pendingLabel="מעביר…" variant="secondary">
                  העברה לאישור
                </SubmitButton>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              ההזמנה ממתינה להעברה לאישור.
            </p>
          )}
        </div>
      )}

      {/* Step two, for whoever talks to the provider. */}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        {maySend ? (
          <form action={send} className="flex flex-col gap-2">
            <input type="hidden" name="channel" value={channel} />
            {sendState !== null && !sendState.ok && (
              <ActionError error={sendState.error} />
            )}
            {sendState !== null && sendState.ok && (
              <p role="status" className="text-xs font-semibold text-success">
                נשלח ל{providerName}.
              </p>
            )}
            <div>
              <SubmitButton pendingLabel="שולח…" variant="primary">
                שליחה ל{providerName}
              </SubmitButton>
            </div>
          </form>
        ) : (
          // Not a disabled button. A disabled control reads as a fault with
          // your account; a sentence naming who does it is the truth.
          <p className="text-sm text-muted-foreground">
            אין לך הרשאה לשלוח הזמנות לספקים. השליחה נעשית על ידי מנהל — את
            ההזמנה עצמה אפשר להכין ולהעביר לאישור.
          </p>
        )}
      </div>
    </Panel>
  )
}

function Panel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby="send-panel-title"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface px-5 py-5 shadow-soft"
    >
      <h2
        id="send-panel-title"
        className="font-display text-base font-bold text-foreground"
      >
        {title}
      </h2>
      {children}
    </section>
  )
}
