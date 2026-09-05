'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. A guest sending their basket.
 *
 * ── What this deliberately does not send ──────────────────────────────────
 *
 * Money. The cart in the browser carries `seenUnitPriceAgorot` and
 * `seenLineTotalAgorot` — what the guest was shown when they added each line —
 * and neither reaches the database. This action forwards item ids, quantities,
 * chosen option values and free-text answers, and `guest_portal_place_order`
 * looks every price up from the catalogue and the property override at the
 * moment it writes.
 *
 * So there is no argument to this path that can change what an order costs. A
 * guest posting their own prices is the obvious attack on a shop, and it is
 * refused by the payload's shape rather than by a comparison somebody has to
 * remember to write.
 *
 * The `seen` figures are still worth carrying in the cart: they are what
 * `revalidate` in `cart.ts` compares against the live catalogue to tell the
 * guest "this went up while you were deciding". That is a courtesy check in
 * the browser, and it is not what protects the price.
 *
 * ── Why the token is the only address ─────────────────────────────────────
 *
 * No booking id, no organization id, no property id — the function resolves
 * all three from the token's own booking. That is the shape 0033 and 0034
 * established, and the reason their IDOR proof holds: there is no parameter a
 * guest could point at somebody else's stay.
 *
 * ── Errors ───────────────────────────────────────────────────────────────
 *
 * Never thrown. A throw inside a Server Action reaches the browser as a digest
 * and a blank screen; every failure here becomes a Hebrew sentence the guest
 * can act on, with the machine code kept for the log.
 */

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/supabase/server'

export type PlaceOrderLine = {
  itemId: string
  quantity: number
  optionValueIds: readonly string[]
  answers: Readonly<Record<string, string | number>>
}

export type PlaceOrderResult =
  | { ok: true; reference: string; replay: boolean }
  | { ok: false; message: string }

/**
 * What each refusal says to a guest.
 *
 * Keyed by the machine code the function raises. The Hebrew lives here rather
 * than being read from the error's `hint`, for the same reason it does in
 * `acceptance.ts`: the database is the authority on *which* refusal happened
 * and the product is the authority on how it is worded. An unrecognised code
 * still produces a real sentence instead of a raw SQLSTATE.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  store_order_empty: 'העגלה ריקה. הוסיפו פריט לפני השליחה.',
  store_disabled: 'החנות אינה פעילה כרגע. אפשר לפנות אלינו ישירות.',
  store_item_unavailable:
    'אחד הפריטים בעגלה כבר אינו זמין. רעננו את הדף ונסו שוב.',
  store_item_requires_quote:
    'הפריט הזה נמכר לפי הצעת מחיר. פנו אלינו ונשלח הצעה.',
  store_option_unavailable:
    'אחת האפשרויות שנבחרו כבר אינה זמינה. רעננו את הדף ונסו שוב.',
  guest_link_not_found: 'הקישור אינו תקין. בקשו מבית האירוח קישור חדש.',
  guest_link_revoked: 'הקישור בוטל. פנו לבית האירוח לקבלת קישור חדש.',
  guest_link_expired: 'תוקף הקישור פג. פנו לבית האירוח לקבלת קישור חדש.',
}

export async function placeGuestOrderAction(input: {
  token: string
  lines: readonly PlaceOrderLine[]
  requestedForDate: string | null
  guestNotes: string | null
  submissionKey: string
}): Promise<PlaceOrderResult> {
  if (input.lines.length === 0) {
    return { ok: false, message: REFUSALS.store_order_empty }
  }

  const db = await createClient()

  const { data, error } = await db.rpc('guest_portal_place_order', {
    p_token: input.token,
    // Reduced to exactly the four fields the function reads. Sending the whole
    // cart line would put the prices the browser holds on the wire, and a
    // payload that carries money invites somebody to start trusting it.
    p_lines: input.lines.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      optionValueIds: [...line.optionValueIds],
      answers: line.answers,
    })),
    p_requested_for: input.requestedForDate,
    p_notes: input.guestNotes,
    p_submission_key: input.submissionKey,
  })

  if (error) {
    const code = (error.message ?? '').trim()
    // Never log the token: it is a bearer credential for this booking.
    console.error('[guest-store] order refused', {
      code,
      submissionKey: input.submissionKey,
    })
    return {
      ok: false,
      message:
        REFUSALS[code] ??
        'לא הצלחנו לשלוח את הבקשה כרגע. נסו שוב בעוד רגע, או פנו אלינו.',
    }
  }

  const row = (data ?? {}) as { reference?: string; replay?: boolean }

  // The order lands `awaiting_approval`, so the page must re-render to show it
  // waiting rather than leaving the basket looking unsent.
  revalidatePath(`/g/${input.token}/store`)
  revalidatePath(`/g/${input.token}`)

  return {
    ok: true,
    reference: row.reference ?? '',
    replay: row.replay === true,
  }
}
