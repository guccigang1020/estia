'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. The guest's own store.
 *
 * Mobile first and RTL, because most guests buy this on a telephone in the car
 * park. Cards, a price, a reason when something cannot be had, a cart that
 * survives a refresh, and one call to action that says whatever the configured
 * payment mode actually requires.
 *
 * ── Why the cart is `localStorage` and not a table ───────────────────────
 *
 * A basket is not a business record. Nobody is owed anything for it, it has no
 * audit trail, and storing one per guest would put an abandoned-cart table
 * into a product whose whole premise is that it does not chase people. It
 * lives in the browser, keyed by the booking, so a refresh does not lose it
 * and two different bookings on one telephone do not share one.
 *
 * Every read and write is wrapped: a private window, cleared site data or a
 * browser that refuses storage must produce an empty cart, never a broken
 * screen.
 *
 * ── The one call to action ───────────────────────────────────────────────
 *
 * `paymentInstructionFor` decides the button's words from the organization's
 * own payment mode. A checkout that always said "שלם" for a business that
 * never takes money online would be the product lying about itself — and the
 * default mode says "אשר והוסף לחשבון השהות", which is the truth.
 *
 * ── What this component cannot do yet, stated where it is visible ────────
 *
 * Sending the order needs a write path a guest is authorized for, and that is
 * a `SECURITY DEFINER` function the guest-portal session owns — see
 * `src/lib/store/portal.ts`. Until it lands, the call to action is present and
 * explains that the request is completed by telephone. It does not pretend to
 * submit and silently fail.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/ui/cn'
import { formatAgorot } from '@/lib/plans/plan'
import {
  ELIGIBILITY_CAVEAT_LABEL,
  cartCount,
  paymentInstructionFor,
  priceCaption,
  type Cart,
  type CartLine,
  type GuestStoreCard,
  type StoreSection,
  type StoreSettings,
} from '@/lib/store'

/* ────────────────────────────────────────────────────────── the basket ── */

/**
 * `localStorage` is an external store, so it is read through the API React
 * provides for external stores.
 *
 * Not a `useEffect` that calls `setState` on mount. That shape works, and it
 * is the one the `react-hooks/set-state-in-effect` rule exists to stop: it
 * renders once with an empty basket, then again with the real one, on every
 * mount. `useSyncExternalStore` reads it during render on the client and takes
 * `getServerSnapshot` for the server — so there is one render, no cascade, and
 * no hydration mismatch.
 *
 * The snapshot must be REFERENTIALLY STABLE between changes or React
 * re-renders forever, which is why the parsed cart is cached per key and the
 * cache is only replaced when something actually writes.
 */

/** One key per booking, so two stays on one telephone never share a basket. */
function cartKey(bookingId: string): string {
  return `estia.store.cart.${bookingId}`
}

const EMPTY: Cart = { lines: [], updatedAt: '' }

/** The last value handed to React, per key. See the note above about identity. */
const snapshots = new Map<string, Cart>()
const listeners = new Map<string, Set<() => void>>()

function parseCart(raw: string | null): Cart {
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as Cart
    return Array.isArray(parsed.lines) ? parsed : EMPTY
  } catch {
    // Whatever is in there is not a basket. An empty one is the right answer.
    return EMPTY
  }
}

function snapshotOf(bookingId: string): Cart {
  const cached = snapshots.get(bookingId)
  if (cached) return cached

  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(cartKey(bookingId))
  } catch {
    // A private window, cleared site data, or a browser refusing storage. An
    // empty basket is the correct answer; a throw would blank the whole store.
    stored = null
  }

  const parsed = parseCart(stored)
  snapshots.set(bookingId, parsed)
  return parsed
}

function publish(bookingId: string, cart: Cart): void {
  snapshots.set(bookingId, cart)

  try {
    window.localStorage.setItem(cartKey(bookingId), JSON.stringify(cart))
  } catch {
    // The basket then lives only for this page view — a degraded experience,
    // and not a failure worth showing anybody.
  }

  for (const listener of listeners.get(bookingId) ?? []) listener()
}

function subscribe(bookingId: string, listener: () => void): () => void {
  const set = listeners.get(bookingId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(bookingId, set)
  return () => {
    set.delete(listener)
  }
}

/** The server has no basket, and rendering one would be a hydration mismatch. */
function serverSnapshot(): Cart {
  return EMPTY
}

export function GuestStore({
  bookingId,
  settings,
  sections,
  cards,
  /** Set on the owner's "preview as guest". Nothing may be added. */
  readOnly = false,
}: {
  bookingId: string
  settings: StoreSettings
  sections: readonly StoreSection[]
  cards: Readonly<Record<string, GuestStoreCard>>
  readOnly?: boolean
}) {
  const cart = useSyncExternalStore(
    useCallback((listener) => subscribe(bookingId, listener), [bookingId]),
    useCallback(() => snapshotOf(bookingId), [bookingId]),
    serverSnapshot,
  )

  function add(card: GuestStoreCard) {
    if (readOnly) return

    const line: CartLine = {
      itemId: card.item.id,
      quantity: 1,
      optionValueIds: card.item.options
        .map(
          (option) =>
            option.values.find((value) => value.isDefault)?.id ??
            option.values[0]?.id,
        )
        .filter((id): id is string => Boolean(id)),
      addons: [],
      answers: {},
      seenUnitPriceAgorot: card.unitPriceAgorot ?? 0,
      seenLineTotalAgorot: card.unitPriceAgorot ?? 0,
    }

    const existing = cart.lines.find((entry) => entry.itemId === card.item.id)
    const lines = existing
      ? cart.lines.map((entry) =>
          entry.itemId === card.item.id
            ? { ...entry, quantity: entry.quantity + 1 }
            : entry,
        )
      : [...cart.lines, line]

    publish(bookingId, { lines, updatedAt: new Date().toISOString() })
  }

  function remove(itemId: string) {
    publish(bookingId, {
      lines: cart.lines.filter((entry) => entry.itemId !== itemId),
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * The basket's total, from what the guest was shown.
   *
   * Recomputed on the server before anything is submitted — see
   * `revalidateCart` — and the guest is told in words about anything that
   * moved. This figure is the screen's, not the order's.
   */
  const total = useMemo(
    () =>
      cart.lines.reduce((sum, line) => {
        const card = cards[line.itemId]
        return sum + (card?.unitPriceAgorot ?? 0) * line.quantity
      }, 0),
    [cart, cards],
  )

  const instruction = paymentInstructionFor(settings.defaultPaymentMode)
  const count = cartCount(cart)

  return (
    <div className="flex flex-col gap-6">
      {settings.guestStoreHeading && (
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-xl font-bold text-foreground">
            {settings.guestStoreHeading}
          </h2>
          {settings.guestStoreIntro && (
            <p className="text-sm text-muted-foreground">
              {settings.guestStoreIntro}
            </p>
          )}
        </div>
      )}

      {sections.map((section) => (
        <section key={section.key} className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h3 className="font-display text-base font-bold text-foreground">
              {section.title}
            </h3>
            {section.subtitle && (
              <p className="text-xs text-muted-foreground">
                {section.subtitle}
              </p>
            )}
          </div>

          <ul className="grid gap-3 sm:grid-cols-2">
            {section.items.map((item) => {
              const card = cards[item.id]
              if (!card) return null

              const inCart = cart.lines.some((line) => line.itemId === item.id)

              return (
                <li
                  key={item.id}
                  className={cn(
                    'flex flex-col gap-2 rounded-xl border border-border bg-surface p-4',
                    !card.verdict.eligible && 'opacity-70',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">
                      {item.name}
                    </span>
                    {item.isFeatured && <Badge tone="accent">מומלץ</Badge>}
                  </div>

                  {item.shortDescription && (
                    <p className="text-sm text-muted-foreground">
                      {item.shortDescription}
                    </p>
                  )}

                  <span className="text-sm font-semibold text-foreground">
                    {card.unitPriceAgorot === null
                      ? 'לפי הצעת מחיר'
                      : priceCaption(
                          item.pricingModel,
                          formatAgorot(card.unitPriceAgorot),
                        )}
                  </span>

                  {/* A refusal the guest can act on, in their own language.
                      A greyed card with no sentence is a support call. */}
                  {!card.verdict.eligible && card.verdict.message && (
                    <p className="text-xs text-muted-foreground">
                      {card.verdict.message}
                    </p>
                  )}

                  {/* Offered, with something we do not yet know. Neither a
                      promise nor a refusal — see `eligibility.ts`. */}
                  {card.verdict.caveats.map((caveat) => (
                    <p key={caveat} className="text-xs text-muted-foreground">
                      {ELIGIBILITY_CAVEAT_LABEL[caveat]}
                    </p>
                  ))}

                  {card.verdict.eligible && (
                    <Button
                      variant={inCart ? 'secondary' : 'primary'}
                      size="sm"
                      className="self-start"
                      disabled={readOnly}
                      onClick={() => {
                        if (inCart) remove(item.id)
                        else add(card)
                      }}
                    >
                      {item.pricingModel === 'quote'
                        ? 'בקשת הצעת מחיר'
                        : inCart
                          ? 'הסרה'
                          : 'הוספה'}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {/* ─────────────────────────────────────────────────── the cart ── */}
      {count > 0 && (
        <aside className="sticky bottom-3 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft">
          <p className="font-semibold text-foreground">
            {count === 1 ? 'פריט אחד בעגלה' : `${count} פריטים בעגלה`}
          </p>

          <ul className="flex flex-col gap-1 text-sm">
            {cart.lines.map((line) => {
              const card = cards[line.itemId]
              return (
                <li
                  key={line.itemId}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-muted-foreground">
                    {card?.item.name ?? 'פריט'}
                    {line.quantity > 1 && ` × ${line.quantity}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      remove(line.itemId)
                    }}
                    className="text-xs text-muted-foreground underline"
                  >
                    הסרה
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">סך הכול</span>
            <span className="font-display text-lg font-bold tabular-nums text-foreground">
              {formatAgorot(total)}
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            {instruction.explanation}
          </p>

          <Button disabled className="w-full">
            {instruction.callToAction}
          </Button>

          {/* Honest, and on screen rather than only in a comment: the button
              is present and inert until the guest write path lands. */}
          <p className="text-xs text-muted-foreground">
            שליחת הבקשה מהמסך הזה עדיין אינה פעילה. אפשר להתקשר אלינו ונסדר את
            זה — הפריטים שבחרתם נשמרים כאן בינתיים.
          </p>
        </aside>
      )}

      {readOnly && (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          זו תצוגה מקדימה. אי אפשר ליצור ממנה הזמנה אמיתית.
        </p>
      )}
    </div>
  )
}
