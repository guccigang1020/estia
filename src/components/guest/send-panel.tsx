'use client'

/**
 * Sending the guest their link.
 *
 * ── "Copy the message" is a complete answer, not a fallback ───────────────
 *
 * Most guesthouses in this market have no WhatsApp Business integration, no
 * SMS gateway and no transactional mail provider. This panel's response to
 * that is not four buttons with three greyed out and a tooltip about what they
 * would need to buy. It composes the message, hands it over, and records the
 * send as real — because it IS real: the owner pastes it into the WhatsApp
 * already open on the same telephone, and "sent and never opened" has to be
 * true for them too.
 *
 * Where a channel's own href can be built — a valid Israeli mobile for
 * WhatsApp or SMS, an address for mail — the button opens that app with the
 * text ready. Where it cannot, the button is not rendered at all rather than
 * rendered dead: a `wa.me` link built from a malformed number opens a chat
 * with nobody, which looks like the product working and is not.
 *
 * ── Recording the send is a separate act from performing it ───────────────
 *
 * Opening WhatsApp does not prove a message was sent, so the record is written
 * when the operator says it was — which is also what makes `copy` honest. The
 * alternative, stamping "sent" the moment a link is clicked, would fill the
 * journey tab with sends that never happened.
 *
 * ── Rotate and revoke both demand a reason ────────────────────────────────
 *
 * The audit line that matters six months later is not "the link was rotated"
 * but "the link was rotated because it had been forwarded to the wrong
 * WhatsApp group". The operation refuses without one; this collects it.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import {
  recordGuestLinkSendAction,
  restoreGuestLinkAction,
  revokeGuestLinkAction,
  rotateGuestLinkAction,
} from '@/lib/guest-journey/admin-actions'
import {
  channelHref,
  composeGuestMessage,
  type GuestMessagePurpose,
} from '@/lib/guest-journey/link'
import {
  GUEST_LINK_CHANNEL_LABEL,
  type GuestLinkChannel,
} from '@/lib/guest-journey/types'

export type SendPanelProps = {
  bookingId: string
  /** Built on the server from the request's own origin. */
  guestLink: string
  guestFirstName: string | null
  guestPhone: string | null
  guestEmail: string | null
  organizationName: string
  propertyName: string | null
  checkIn: string
  checkOut: string
  sendCount: number
  revokedAt: string | null
  canSend: boolean
  canManage: boolean
}

export function SendPanel(props: SendPanelProps) {
  const router = useRouter()
  const { pending, run } = useAsyncAction()

  const [link, setLink] = useState(props.guestLink)
  const [copied, setCopied] = useState<'link' | 'message' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState<'rotate' | 'revoke' | 'restore' | null>(
    null,
  )

  const purpose: GuestMessagePurpose =
    props.sendCount === 0 ? 'first' : 'reminder'
  const message = composeGuestMessage({
    purpose,
    guestFirstName: props.guestFirstName,
    organizationName: props.organizationName,
    propertyName: props.propertyName,
    checkIn: props.checkIn,
    checkOut: props.checkOut,
    url: link,
  })

  async function copy(text: string, what: 'link' | 'message') {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      // Cleared so a stale "הועתק" does not sit under a button the operator
      // pressed two minutes ago.
      window.setTimeout(() => setCopied(null), 2500)
    } catch {
      setProblem('הדפדפן לא איפשר העתקה. סמן את הטקסט והעתק ידנית.')
    }
  }

  function recordSend(channel: GuestLinkChannel, recipient: string | null) {
    if (pending) return
    setProblem(null)
    setNote(null)

    void run(async () => {
      const result = await recordGuestLinkSendAction({
        bookingId: props.bookingId,
        channel,
        recipient,
        // One key per act of sending. A double-click on "record" is one send;
        // a genuine resend five minutes later is a new key and a new row.
        idempotencyKey: crypto.randomUUID(),
      })

      if (result.ok) {
        setNote(`נרשמה שליחה בערוץ ${GUEST_LINK_CHANNEL_LABEL[channel]}.`)
        router.refresh()
        return
      }
      setProblem(result.error.message)
    })
  }

  function runManaged(kind: 'rotate' | 'revoke' | 'restore') {
    if (pending) return
    const stated = reason.trim()
    if (stated.length < 3) {
      setProblem('יש להזין סיבה קצרה. היא נשמרת ביומן הביקורת.')
      return
    }

    setProblem(null)
    setNote(null)

    void run(async () => {
      const input = {
        bookingId: props.bookingId,
        reason: stated,
        idempotencyKey: crypto.randomUUID(),
      }

      if (kind === 'rotate') {
        const result = await rotateGuestLinkAction(input)
        if (result.ok) {
          // Shown once, to the person who asked for it. It is not in the audit
          // row and not in the stored operation result.
          setLink(result.data.url)
          setNote('הונפק קישור חדש. כל העותקים הקודמים הפסיקו לעבוד.')
          setAsking(null)
          setReason('')
          router.refresh()
          return
        }
        setProblem(result.error.message)
        return
      }

      const result =
        kind === 'revoke'
          ? await revokeGuestLinkAction(input)
          : await restoreGuestLinkAction(input)

      if (result.ok) {
        setNote(kind === 'revoke' ? 'הקישור בוטל.' : 'הקישור פעיל שוב.')
        setAsking(null)
        setReason('')
        router.refresh()
        return
      }
      setProblem(result.error.message)
    })
  }

  const whatsapp = channelHref('whatsapp', message, props.guestPhone)
  const sms = channelHref('sms', message, props.guestPhone)
  const email = channelHref('email', message, props.guestEmail)

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-display text-base font-bold text-foreground">
          שליחת הקישור לאורח
        </h3>
        <p className="text-sm text-muted-foreground">
          {props.revokedAt
            ? 'הקישור מבוטל. הנפק קישור חדש כדי לשלוח שוב.'
            : props.sendCount === 0
              ? 'הקישור עוד לא נשלח.'
              : `נשלח ${props.sendCount} פעמים.`}
        </p>
      </header>

      {/* The link itself, always visible and always copyable. This is the one
          control that works for every business regardless of integrations. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs">
            {link}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copy(link, 'link')}
          >
            {copied === 'link' ? 'הועתק' : 'העתקת הקישור'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copy(message.body, 'message')}
          >
            {copied === 'message' ? 'הועתק' : 'העתקת ההודעה'}
          </Button>
          <Button variant="ghost" size="sm" href={link} target="_blank">
            תצוגה כאורח
          </Button>
        </div>
      </div>

      {props.canSend && !props.revokedAt && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-sm font-medium text-foreground">
            שליחה, ורישום שנשלח
          </p>

          <div className="flex flex-wrap gap-2">
            {whatsapp && (
              <Button
                variant="secondary"
                size="sm"
                href={whatsapp}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => recordSend('whatsapp', props.guestPhone)}
              >
                וואטסאפ
              </Button>
            )}
            {sms && (
              <Button
                variant="secondary"
                size="sm"
                href={sms}
                onClick={() => recordSend('sms', props.guestPhone)}
              >
                SMS
              </Button>
            )}
            {email && (
              <Button
                variant="secondary"
                size="sm"
                href={email}
                onClick={() => recordSend('email', props.guestEmail)}
              >
                דוא״ל
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => recordSend('copy', null)}
            >
              שלחתי ידנית
            </Button>
          </div>

          {!whatsapp && !sms && !email && (
            <p className="text-xs text-muted-foreground">
              אין לאורח טלפון או דוא״ל שמורים, ולכן אין ערוץ ישיר. העתק את
              ההודעה ושלח בעצמך — ואז סמן ״שלחתי ידנית״ כדי שהמעקב יישאר נכון.
            </p>
          )}
        </div>
      )}

      {props.canManage && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-sm font-medium text-foreground">ניהול הקישור</p>

          {asking === null ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAsking('rotate')}
              >
                הנפקת קישור חדש
              </Button>
              {props.revokedAt ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setAsking('restore')}
                >
                  ביטול הביטול
                </Button>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setAsking('revoke')}
                >
                  ביטול הקישור
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-border-strong bg-surface px-3 py-3">
              <p className="text-sm text-foreground">
                {asking === 'rotate'
                  ? 'הנפקת קישור חדש מבטלת מיד כל עותק קיים, כולל זה ששמור אצל האורח.'
                  : asking === 'revoke'
                    ? 'ביטול מונע מהאורח לפתוח את הקישור. אפשר לבטל את הביטול בהמשך.'
                    : 'הקישור הקיים יחזור לעבוד.'}
              </p>

              <Field label="סיבה" description="נשמרת ביומן הביקורת" required>
                <TextInput
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="למשל: הקישור נשלח למספר שגוי"
                />
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={asking === 'revoke' ? 'danger' : 'primary'}
                  disabled={pending}
                  onClick={() => runManaged(asking)}
                >
                  {pending ? 'מבצע…' : 'אישור'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAsking(null)
                    setReason('')
                    setProblem(null)
                  }}
                >
                  ביטול
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {note && (
        <p
          role="status"
          className="rounded-lg border border-success bg-success/10 px-3 py-2 text-sm text-foreground"
        >
          {note}
        </p>
      )}

      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
        >
          {problem}
        </p>
      )}
    </section>
  )
}
