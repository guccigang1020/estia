/**
 * The key that stops a double-tapped submit becoming two orders.
 *
 * ── The failure this exists for ───────────────────────────────────────────
 *
 * A guest on a telephone, on hotel wifi, presses "שלח הזמנה". Nothing visibly
 * happens for two seconds, so they press it again. Two requests are now in
 * flight for one purchase, and the outcomes that must not occur are two
 * orders, two operational tasks, two requests to the DJ, and two charges.
 *
 * ── Why the pipeline's own key is not enough on its own ───────────────────
 *
 * `src/lib/service/idempotency.ts` refuses a replay of the SAME key, and that
 * is the right primitive. It cannot help with the case the guest actually
 * produces: the page reloaded between the two taps, the client generated a
 * fresh key, and the two requests are now genuinely different requests that
 * mean the same purchase.
 *
 * So the key here is **derived from the purchase**, not generated per request.
 * Two taps that mean the same thing produce the same string, whether the
 * client remembered its key or not.
 *
 * ── What goes into it, and why each part ──────────────────────────────────
 *
 *     organizationId    two tenants may not collide, ever
 *     bookingId         the same purchase on two stays is two purchases
 *     the line set      item, quantity, chosen options and add-ons — SORTED,
 *                       so that a cart rendered in a different order is still
 *                       the same cart
 *     requestedForDate  the same massage on Friday and on Saturday is two
 *                       orders, and a key that ignored the date would silently
 *                       swallow the second
 *
 * ── What is deliberately NOT in it ────────────────────────────────────────
 *
 *     the price         a price that moved between the two taps is exactly the
 *                       case §12 says to surface — the cart is revalidated and
 *                       the guest is shown what changed. If the price were in
 *                       the key, the second tap would create a second order at
 *                       the new price, which is the outcome this whole module
 *                       exists to prevent.
 *     the timestamp     an obvious mistake worth naming: a key containing the
 *                       moment is unique by construction and therefore is not
 *                       an idempotency key at all.
 *     the guest's notes a typo corrected between taps is not a second order.
 *
 * ── Where it is enforced ──────────────────────────────────────────────────
 *
 * It is written to `store_orders.submission_key` and
 * `store_orders_submission_key_idx` is UNIQUE per organization. Uniqueness at
 * the row is the only place a race can actually be lost; a check-then-insert
 * in the application loses it every time under load.
 *
 * ── Why it is a stable hash and not the raw string ────────────────────────
 *
 * The raw description of a cart can be long and carries product ids into a
 * column that is read by list screens. A hex digest is fixed-width, indexes
 * well and discloses nothing. `crypto.subtle` is used rather than
 * `node:crypto` for the reason `src/lib/invitations/token.ts` gives: it is
 * present in Node, in the Edge runtime and in the test environment alike.
 */

/** One line of a cart, as the key sees it. */
export type SubmissionLine = {
  itemId: string
  quantity: number
  optionValueIds?: readonly string[]
  addonIds?: readonly string[]
}

export type SubmissionInput = {
  organizationId: string
  bookingId: string | null
  requestedForDate: string | null
  lines: readonly SubmissionLine[]
}

/**
 * The canonical description of a purchase.
 *
 * Exported for the tests, which assert the stability property directly: two
 * carts differing only in the order of their lines and options must produce
 * the same string.
 */
export function submissionFingerprint(input: SubmissionInput): string {
  const lines = input.lines
    .map((line) =>
      [
        line.itemId,
        String(Math.trunc(line.quantity)),
        [...(line.optionValueIds ?? [])].sort().join('+'),
        [...(line.addonIds ?? [])].sort().join('+'),
      ].join('|'),
    )
    .sort()

  return [
    'store.order',
    input.organizationId,
    input.bookingId ?? '-',
    input.requestedForDate ?? '-',
    lines.join(';'),
  ].join('~')
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** What `store_orders.submission_key` receives. */
export async function submissionKey(input: SubmissionInput): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(submissionFingerprint(input)),
  )
  return toHex(digest)
}

/**
 * The key handed to the service pipeline for a store operation.
 *
 * Namespaced by the operation, so that approving an order and cancelling it
 * cannot replay each other's stored result — the pipeline scopes by operation
 * name as well, and this is the belt to that pair of braces.
 */
export function operationIdempotencyKey(
  operation: string,
  resourceId: string,
  discriminator?: string,
): string {
  return [operation, resourceId, discriminator ?? '-'].join(':')
}
