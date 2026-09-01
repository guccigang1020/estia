/**
 * Which of the owner's products this particular guest is shown first.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  PERSONALIZATION NEVER INVENTS.
 *
 *  It ranks and it sections. It cannot surface a product the owner has not
 *  created, and it never renders an empty section.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * That sentence is the whole design. A recommendation engine that fills a
 * quiet store with plausible suggestions is the single worst thing this module
 * could do: the guest asks for the thing they were shown, and the owner has to
 * explain that it does not exist. So the input is exactly the eligible items,
 * the output is a permutation of them grouped into sections, and there is no
 * code path that adds one.
 *
 * ── What it ranks against ────────────────────────────────────────────────
 *
 * The booking's own facts, which the business already knows and the guest
 * already told it:
 *
 *   · the party — two adults is a couple, adults with children is a family,
 *     twenty-five heads is a group
 *   · the occasion, when the guest stated one
 *   · how close the arrival is — a service needing seventy-two hours' notice
 *     is not the first thing to show somebody arriving tomorrow
 *   · what the owner marked as featured, which is a human judgement and beats
 *     every heuristic here
 *
 * ── Ranking is not filtering ─────────────────────────────────────────────
 *
 * A product that matches nothing about this booking is still shown. It is
 * shown lower. The owner put it in the catalogue and a guest looking for it
 * must be able to find it — the distinction between "less relevant" and
 * "hidden" is the difference between a helpful store and one that appears
 * broken.
 */

import type { BookingFacts, CatalogueItem, StoreCategory } from './types'
import { partySize } from './types'
import { nightsBetween } from './pricing'

/** What kind of party this is. Derived, never asked. */
export type PartyShape = 'couple' | 'family' | 'group' | 'solo' | 'unknown'

export function partyShapeOf(booking: BookingFacts | null): PartyShape {
  if (!booking) return 'unknown'

  const heads = partySize(booking)
  if (booking.children > 0 || booking.infants > 0) return 'family'
  if (heads >= 8) return 'group'
  if (heads === 2) return 'couple'
  if (heads === 1) return 'solo'
  return 'unknown'
}

/**
 * How well one product fits this stay. Higher is more relevant.
 *
 * The weights are small integers and deliberately legible: this is a sorting
 * hint that a person should be able to reason about from the screen, not a
 * model. Nothing here is learned, nothing is remembered between guests, and
 * the same booking always produces the same order.
 */
export function relevanceScore(
  item: CatalogueItem,
  booking: BookingFacts | null,
  now: Date,
): number {
  let score = 0

  // The owner's own judgement outranks every heuristic below.
  if (item.isFeatured) score += 10

  const shape = partyShapeOf(booking)
  const audience = item.audience

  if (shape === 'couple' && audience.suitsCouple) score += 6
  if (shape === 'family' && audience.suitsFamily) score += 6
  if (shape === 'group' && audience.suitsGroup) score += 6

  // An occasion the guest actually stated. Never inferred from a date — a
  // stay in February is not a Valentine's booking because the calendar says so.
  if (
    booking?.occasion &&
    audience.occasions &&
    audience.occasions.includes(booking.occasion)
  ) {
    score += 8
  }

  // A guest band the party sits comfortably inside is a small positive; one it
  // sits at the edge of is neutral. Being outside it entirely is not scored
  // here at all, because `eligibility.ts` has already refused that product.
  //
  // ONLY WHERE THE OWNER ACTUALLY DECLARED A BAND. This originally defaulted
  // the missing bounds to 0 and infinity, which meant every product in the
  // catalogue scored +2 for every booking — and that quietly destroyed the
  // property the highlight strip depends on: `sectionsFor` shows "מומלץ
  // עבורכם" only above a neutral floor, and a floor everything clears is not a
  // floor. A strip built from it would have been "recommended for you" over an
  // arbitrary sort, which is exactly the invented recommendation §10 forbids.
  if (booking && (item.minGuests !== null || item.maxGuests !== null)) {
    const heads = partySize(booking)
    const min = item.minGuests ?? 0
    const max = item.maxGuests ?? Number.MAX_SAFE_INTEGER
    if (heads > min && heads < max) score += 2
  }

  // Lead time against how close the arrival actually is. A DJ needing three
  // days is not the first card for somebody arriving tomorrow — but it is
  // still shown, because they may be booking for next month.
  if (booking && item.leadTimeHours > 0) {
    const hoursToArrival =
      (Date.parse(`${booking.checkIn}T15:00:00Z`) - now.getTime()) / 3_600_000
    if (
      Number.isFinite(hoursToArrival) &&
      hoursToArrival < item.leadTimeHours
    ) {
      score -= 5
    }
  }

  // A per-night product on a long stay is worth more of the guest's attention
  // than on a single night, because it is the case where it changes the stay.
  if (booking && item.pricingModel === 'per_night') {
    const nights = nightsBetween(booking.checkIn, booking.checkOut)
    if (nights >= 3) score += 2
  }

  return score
}

/**
 * One section of the guest store.
 *
 * `items` is never empty. `sectionsFor` drops an empty section rather than
 * rendering a heading with nothing under it, which is §10's second sentence.
 */
export type StoreSection = {
  key: string
  /** Hebrew. The category's own name, or one of the two derived headings. */
  title: string
  /** Why this section is here, when it is not simply a category. */
  subtitle: string | null
  items: readonly CatalogueItem[]
}

/**
 * Section and rank the items this guest may actually buy.
 *
 * `items` must already have been through `evaluateEligibility` — this function
 * does not refuse anything, and handing it the whole catalogue would show a
 * guest products they cannot have.
 *
 * The shape of the result:
 *
 *   1. **מומלץ עבורכם**, when and only when some product genuinely scores for
 *      this booking. A "recommended" strip built from the top of an
 *      arbitrary sort is a lie with a heading on it, so the section appears
 *      only when at least one item scored above the neutral floor.
 *   2. **The owner's own categories**, in the owner's own order, each holding
 *      the items they put in it, ranked within the section.
 *   3. **A single catch-all** for items in no category — headed plainly, not
 *      "אחר", because "other" reads as leftovers and these are products the
 *      owner sells.
 */
export function sectionsFor(input: {
  items: readonly CatalogueItem[]
  categories: readonly StoreCategory[]
  booking: BookingFacts | null
  now: Date
  /** How many the highlight strip holds. Small: it is a strip, not a page. */
  highlightLimit?: number
}): readonly StoreSection[] {
  const { items, categories, booking, now } = input
  if (items.length === 0) return []

  const scored = items.map((item) => ({
    item,
    score: relevanceScore(item, booking, now),
  }))

  const byRelevance = (
    a: { item: CatalogueItem; score: number },
    b: { item: CatalogueItem; score: number },
  ) =>
    b.score - a.score ||
    a.item.sortOrder - b.item.sortOrder ||
    a.item.name.localeCompare(b.item.name, 'he')

  const sections: StoreSection[] = []

  // ── 1. The highlight strip, only where it is honest ───────────────────
  // The floor is deliberately above zero: `isFeatured` alone scores 10, and a
  // product that matched nothing about this guest scores 0 or less. A strip
  // built from zeros would be "recommended for you" over an arbitrary sort.
  const highlights = [...scored]
    .filter((entry) => entry.score > 0)
    .sort(byRelevance)
    .slice(0, input.highlightLimit ?? 4)

  if (highlights.length > 0) {
    sections.push({
      key: 'highlights',
      title: 'מומלץ עבורכם',
      subtitle: subtitleFor(booking),
      items: highlights.map((entry) => entry.item),
    })
  }

  // ── 2. The owner's categories, in the owner's order ───────────────────
  const ordered = [...categories]
    .filter((category) => category.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  for (const category of ordered) {
    const inCategory = scored
      .filter((entry) => entry.item.categoryId === category.id)
      .sort(byRelevance)

    // Never render an empty store section. §10.
    if (inCategory.length === 0) continue

    sections.push({
      key: `category:${category.id}`,
      title: category.name,
      subtitle: category.description,
      items: inCategory.map((entry) => entry.item),
    })
  }

  // ── 3. Everything the owner did not file ──────────────────────────────
  const known = new Set(ordered.map((category) => category.id))
  const unfiled = scored
    .filter(
      (entry) =>
        entry.item.categoryId === null || !known.has(entry.item.categoryId),
    )
    .sort(byRelevance)

  if (unfiled.length > 0) {
    sections.push({
      key: 'unfiled',
      // Not "אחר". These are products the owner sells, not leftovers.
      title: sections.length === 0 ? 'מה אפשר להוסיף לשהות' : 'עוד אצלנו',
      subtitle: null,
      items: unfiled.map((entry) => entry.item),
    })
  }

  return sections
}

/**
 * The one sentence under the highlight strip.
 *
 * Says what it is basing itself on, in the guest's own terms, because a
 * recommendation whose reasoning is invisible reads as surveillance. It never
 * states a fact the guest did not give the business.
 */
function subtitleFor(booking: BookingFacts | null): string | null {
  if (!booking) return null

  switch (partyShapeOf(booking)) {
    case 'family':
      return 'לפי מה שסיפרתם לנו — משפחה עם ילדים.'
    case 'couple':
      return 'לפי מה שסיפרתם לנו — שהות זוגית.'
    case 'group':
      return 'לפי מה שסיפרתם לנו — קבוצה גדולה.'
    case 'solo':
    case 'unknown':
      return null
  }
}
