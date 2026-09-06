'use client'

/**
 * WHAT A PERSON CAN DO TO A THREAD, TODAY.
 *
 * Take it, hand it back, mark it read for themselves, close it.
 *
 * ── There is no reply box, and the absence is stated rather than hidden ───
 *
 * An outbound message must reference a `guest_messages` row, and the messaging
 * module sends one of three templated kinds — there is no free text to send a
 * typed sentence as. A box that accepted a reply and then failed, or worse
 * appeared to succeed, would be a worse product than one that says what it
 * cannot do. The panel above this control carries that sentence.
 *
 * ── "Read" is this person's own ──────────────────────────────────────────
 *
 * The button says מסמן שקראתי rather than מסמן כנקרא, because it does not
 * clear the thread for anybody else and the wording should not imply it does.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  assignConversationAction,
  closeConversationAction,
  markConversationReadAction,
} from '@/app/(app)/inbox/_lib/actions'

export function ThreadControls({
  conversationId,
  expectedVersion,
  readerUserId,
  assignedToMe,
  unread,
}: {
  conversationId: string
  expectedVersion: number
  /** Passed in rather than read here: a Client Component has no session, and
   *  guessing an id is how one person takes another persons thread. */
  readerUserId: string
  assignedToMe: boolean
  unread: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingClose, setConfirmingClose] = useState(false)

  async function run(
    work: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ) {
    setBusy(true)
    setError(null)
    const result = await work()
    setBusy(false)
    if (!result.ok) {
      setError(result.error?.message ?? 'הפעולה נכשלה.')
      return
    }
    setConfirmingClose(false)
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(() =>
            assignConversationAction({
              conversationId,
              // Handing it back to the queue must stay expressible: an inbox
              // where only taking is possible fills with threads owned by
              // whoever touched them first and then went on holiday.
              assignToUserId: assignedToMe ? null : readerUserId,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
            }),
          )
        }
        className="text-xs underline disabled:opacity-50"
      >
        {assignedToMe ? 'החזר לתור' : 'קח אחריות'}
      </button>

      {unread && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(() =>
              markConversationReadAction({
                conversationId,
                idempotencyKey: crypto.randomUUID(),
              }),
            )
          }
          className="text-xs underline disabled:opacity-50"
        >
          סמן שקראתי
        </button>
      )}

      {confirmingClose ? (
        <span className="flex items-center gap-2 text-xs">
          לסגור את השיחה?
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() =>
                closeConversationAction({
                  conversationId,
                  expectedVersion,
                  idempotencyKey: crypto.randomUUID(),
                }),
              )
            }
            className="underline disabled:opacity-50"
          >
            כן
          </button>
          <button
            type="button"
            onClick={() => setConfirmingClose(false)}
            className="underline"
          >
            בטל
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmingClose(true)}
          className="text-xs underline disabled:opacity-50"
        >
          סגור שיחה
        </button>
      )}

      {error !== null && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </div>
  )
}
