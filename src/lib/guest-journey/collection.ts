/**
 * EXECUTION CONTEXT — SERVER ONLY. What the guest owes, asked of the one
 * module entitled to answer.
 *
 * ── This file computes no policy ──────────────────────────────────────────
 *
 * That sentence is the whole point of the file, so it is the first one. The
 * payment-collection module owns "what must happen before this booking is
 * confirmed", and `resolveCollectionPolicy` is the single implementation of
 * it — organization default, then per-booking override replacing it whole.
 * Nothing here re-derives any part of that. What this file does is:
 *
 *   1. read `guest_collection_context(token)`, which returns FACTS and never a
 *      decision — its own comment says so;
 *   2. map the rows with that module's own `settingsFromRow`, `overrideFromRow`
 *      and `channelFromRow`, rather than parsing them a second way here;
 *   3. supply the two facts the RPC cannot know, because they live in tables
 *      0034 created — `guestConfirmed` and `contractSigned`;
 *   4. hand all of it to `resolveCollectionPolicy` and then `nextGuestAction`.
 *
 * A `switch` on `decision.policy` anywhere in `src/lib/guest-journey` or
 * `src/app/g` is a bug, and reviewing for one is cheap because there is exactly
 * one legitimate consumer of the result: the panel.
 *
 * ── Why the two facts come from here and not from the RPC ─────────────────
 *
 * `guest_collection_context` was written before `booking_guest_confirmations`
 * and `booking_contract_signatures` existed, and it cannot read them. That is
 * not a defect to route around — it is the correct dependency direction.
 * Consent belongs to the guest journey; the payment module consumes it as a
 * fact, the same way it consumes "how much has been captured". The seam is one
 * function and it is this one.
 *
 * ── Failing closed, twice, and both are reported ──────────────────────────
 *
 * `settledLiveAgorot` and `managerApproved` are set conservatively below, with
 * the reasoning at each. Both are noted in the report as gaps for the payment
 * module rather than papered over, because the direction they fail in — a
 * booking that stays outstanding — costs a telephone call, and the other
 * direction would confirm a booking nobody paid for.
 */

import type { Db } from '../persistence'
import { toRow } from '../persistence'
import {
  channelFromRow,
  overrideFromRow,
  settingsFromRow,
} from '../payments/repository'
import { nextGuestAction, type GuestAction } from '../payments/guest-action'
import {
  resolveCollectionPolicy,
  type CollectionDecision,
} from '../payments/resolver'
import type {
  CollectionFacts,
  CollectionOverride,
  CollectionSettings,
  ManualChannel,
} from '../payments/types'

import type { GuestJourney } from './types'

/**
 * Booking statuses that mean a person at the business has said yes.
 *
 * Inferred from the state machine rather than stored, because there is no
 * `manager_approved_at` column anywhere in the schema and inventing one here
 * would be this module deciding something the booking domain owns. Everything
 * from `confirmed` onward has passed a human; `deposit_paid` deliberately has
 * not, because money arriving is not the same as somebody accepting the stay.
 */
const MANAGER_APPROVED_STATUSES: ReadonlySet<string> = new Set([
  'confirmed',
  'pre_arrival',
  'ready_for_check_in',
  'checked_in',
  'in_house',
  'checkout_pending',
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
])

/** Nothing is asked of a guest whose booking is over or was called off. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'no_show',
  'completed',
])

export type GuestCollection = {
  decision: CollectionDecision
  /** The one thing to ask of them. Never a menu — see `guest-action.ts`. */
  action: GuestAction
  /** The organization's own message, shown above the action. */
  guestInstructions: string | null
  /**
   * True when the policy wants money and the product cannot yet take a
   * receipt. Drives the honest sentence in place of an upload control — there
   * is no file storage in this codebase, and a half-built one would be worse
   * than saying so.
   */
  proofUploadUnavailable: boolean
}

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {}
}

function integer(row: Json, key: string): number {
  const found = row[key]
  if (typeof found === 'number' && Number.isFinite(found)) return found
  if (typeof found === 'string') {
    const parsed = Number(found)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * The channel objects the RPC returns are already the guest-facing shape —
 * enabled only, sorted, and carrying no internal note. `channelFromRow` wants
 * the full row, so the two fields the projection deliberately omits are
 * supplied here: `enabled` is true by construction (the RPC filters on it) and
 * the id is not disclosed to a guest and is not needed by anything downstream.
 */
function channelsFrom(value: unknown): ManualChannel[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) =>
    channelFromRow(toRow({ ...object(entry), id: '', enabled: true })),
  )
}

/**
 * Is this "the function does not exist", as opposed to any other failure?
 *
 * PostgREST answers `PGRST202` when a function is not in its schema cache;
 * Postgres itself answers `42883` (undefined_function) when it is reached
 * directly. Both are checked, and nothing else is: widening this to a message
 * match would eventually swallow a refused token.
 */
function isMissingFunction(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'PGRST202' || code === '42883'
}

let warnedAboutCollection = false

/** Once per process, not once per guest. A line per page view trains people to scroll past it. */
function warnCollectionUnavailable(): void {
  if (warnedAboutCollection) return
  warnedAboutCollection = true
  console.warn(
    '[guest-journey] guest_collection_context is not in this database, so the ' +
      'guest portal is treating every booking as collecting nothing. Apply ' +
      'supabase/migrations/0031_payment_collection.sql to restore the real ' +
      'collection policy.',
  )
}

/**
 * What the resolver itself returns for an organization that has configured no
 * collection policy — produced through `resolveCollectionPolicy`, not written
 * out by hand, so this path cannot drift from the configured one.
 */
function unconfiguredCollection(journey: GuestJourney): GuestCollection {
  const decision = resolveCollectionPolicy({
    settings: null,
    override: null,
    facts: {
      bookingTotalAgorot: journey.current.totalAgorot,
      settledAgorot: 0,
      settledLiveAgorot: 0,
      managerApproved: MANAGER_APPROVED_STATUSES.has(journey.current.status),
      guestConfirmed: journey.confirmation !== null,
      contractSigned: journey.contract.signature !== null,
      proofSubmitted: false,
    },
  })

  const action = nextGuestAction({
    decision,
    channels: [],
    bookingClosed: CLOSED_STATUSES.has(journey.current.status),
  })

  return {
    decision,
    action,
    guestInstructions: decision.guestInstructions,
    proofUploadUnavailable: action.offerProofUpload,
  }
}

/**
 * Read the collection context and resolve it.
 *
 * `journey` is passed rather than re-read: it has already been resolved once
 * for this request by `loadGuestJourney`, and asking the database a second time
 * would risk the two halves of one screen disagreeing about whether the guest
 * has confirmed.
 */
export async function guestCollection(
  db: Db,
  token: string,
  journey: GuestJourney,
): Promise<GuestCollection> {
  const { data, error } = await db.rpc('guest_collection_context', {
    p_guest_token: token.trim(),
  })

  if (error) {
    // `guest_collection_context` lives in migration 0031, which is written and
    // NOT applied to this database. Its absence is reported once and treated as
    // "this organization collects nothing" — which is what
    // `resolveCollectionPolicy` returns for a null settings row anyway, and is
    // the most common real configuration in this market.
    //
    // This is a deliberate, narrow fallback and not a general catch: only "the
    // function is not in the schema" is swallowed, and every other failure —
    // a refused token, a broken tenant, a timeout — propagates. The alternative
    // was a 500 on every guest page in the product until somebody applies a
    // migration this module does not own, and a dark portal is the one failure
    // a guest cannot route around: they have no account and no support screen.
    if (!isMissingFunction(error)) throw error
    warnCollectionUnavailable()
    return unconfiguredCollection(journey)
  }

  const payload = object(data)
  const booking = object(payload.booking)
  const collected = object(payload.collected)

  const settings: CollectionSettings | null =
    payload.settings === null || payload.settings === undefined
      ? null
      : settingsFromRow(toRow(object(payload.settings)))

  const override: CollectionOverride | null =
    payload.override === null || payload.override === undefined
      ? null
      : overrideFromRow(toRow(object(payload.override)))

  const channels = channelsFrom(payload.channels)

  const captured = integer(collected, 'captured_agorot')
  const refunded = integer(collected, 'refunded_agorot')
  const proofCount = integer(collected, 'proof_count')

  const facts: CollectionFacts = {
    bookingTotalAgorot: integer(booking, 'total_agorot'),
    settledAgorot: Math.max(0, captured - refunded),

    // GAP, reported rather than guessed. `guest_collection_context` returns
    // one captured total and does not split provider payments from recorded
    // ones, so the live figure cannot be derived here. Zero is the closed
    // direction: a `deposit_paid_live` policy stays outstanding, which costs a
    // telephone call — where a guess would confirm a booking on money that may
    // have arrived by bank transfer instead of on the card the policy demanded.
    settledLiveAgorot: 0,

    managerApproved: MANAGER_APPROVED_STATUSES.has(journey.current.status),

    // The two facts the RPC cannot know, because they live in 0034's tables.
    // This is the seam described at the head of the file.
    guestConfirmed: journey.confirmation !== null,
    contractSigned: journey.contract.signature !== null,

    proofSubmitted: proofCount > 0,
  }

  const decision = resolveCollectionPolicy({ settings, override, facts })

  const action = nextGuestAction({
    decision,
    channels,
    bookingClosed: CLOSED_STATUSES.has(journey.current.status),
    // A receipt is in and nobody has looked at it. Asking again for money that
    // may already have arrived is how a guest pays twice.
    awaitingProofReview: proofCount > 0 && !decision.confirmable,
  })

  return {
    decision,
    action,
    guestInstructions: decision.guestInstructions,
    // There is no file storage in this product — no bucket, no
    // `supabase.storage`. The action may ask for a receipt; the control to
    // attach one does not exist, and this flag is what lets the screen say so
    // in one sentence instead of rendering a file input that cannot work.
    proofUploadUnavailable: action.offerProofUpload,
  }
}
