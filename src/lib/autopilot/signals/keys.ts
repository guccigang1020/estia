/**
 * One ongoing problem, one key — and the graph of what caused what.
 *
 * ── The most damaging bug this directory could ship ───────────────────────
 *
 * A shortage noticed every five minutes for six hours is ONE problem. If the
 * key that identifies it contains the moment it was noticed, it is seventy-two
 * problems, the exceptions table fills with them overnight, and the manager
 * who opens the screen at 06:00 sees a wall of identical rows and stops
 * reading the screen. Nothing else in Autopilot recovers from that: the
 * feature is judged on the first morning it is wrong.
 *
 * So `signalKey` refuses to build a key from a clock reading, and it refuses
 * loudly. A silent slice or a lint rule would both have to be remembered;
 * throwing is what turns "we must remember" into "it does not get past the
 * suite".
 *
 * ── A calendar date is identity; an instant is a clock reading ────────────
 *
 * `opportunity.empty_night:property:abc:2026-09-12` is correct and stable:
 * the twelfth of September is WHICH empty night, not when somebody looked. The
 * same night detected at 06:00 and at 06:05 produces the same key, which is
 * exactly what is wanted. `2026-09-12T06:05` would not.
 *
 * The distinction is therefore drawn between a date and an instant rather than
 * between "has digits" and "has none", and the guard is written that way.
 *
 * ── Why `resourceId` is scanned less strictly ─────────────────────────────
 *
 * A resource id is opaque — a UUID this module did not choose. A UUID can
 * legitimately contain a twelve-digit run, so scanning it for long digit runs
 * would throw at random on roughly one identifier in two hundred, which is a
 * worse failure than the one being prevented. It is still scanned for an
 * instant, which a UUID cannot contain: there are no colons in a UUID.
 */

import type { AutopilotDomain } from '../../contracts/states'
import type { Signal } from '../types'

/** `2026-09-12T06:05` or `2026-09-12 06:05` — a moment, not a day. */
const INSTANT = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

/** Epoch milliseconds, and any other long bare number that reads like one. */
const CLOCK_LIKE_NUMBER = /\b\d{10,}\b/

const SEPARATOR = ':'
/** What stands in for a resource that has no id. Never an empty segment. */
const NO_RESOURCE = '-'

export interface SignalKeyParts {
  /** The signal's own code: `inventory.shortage`, `laundry.delivery_late`. */
  code: string
  /** What the problem is about: `booking`, `property`, `task`, `item`. */
  resourceType: string
  resourceId: string | null
  /**
   * Which problem of this code on this resource.
   *
   * Two shortages of two different items on one property are two problems and
   * must not collide; the item is the aspect. A date is a legitimate aspect —
   * see the header — and a timestamp is not.
   */
  aspect?: string
}

/**
 * The stable identity of one ongoing problem.
 *
 * Deliberately not hashed. A key a human can read is a key a human can grep
 * for during an incident, and the uniqueness this needs is exactness rather
 * than shortness.
 */
export function signalKey(parts: SignalKeyParts): string {
  assertNoClock('code', parts.code, true)
  assertNoClock('resourceType', parts.resourceType, true)
  if (parts.resourceId !== null) {
    // Instants only. See the header: a UUID may contain a long digit run.
    assertNoClock('resourceId', parts.resourceId, false)
  }
  if (parts.aspect !== undefined) {
    assertNoClock('aspect', parts.aspect, true)
  }

  const segments = [
    parts.code,
    parts.resourceType,
    parts.resourceId ?? NO_RESOURCE,
    ...(parts.aspect === undefined ? [] : [parts.aspect]),
  ]
  return segments.join(SEPARATOR)
}

function assertNoClock(
  field: string,
  value: string,
  scanNumbers: boolean,
): void {
  if (INSTANT.test(value)) {
    throw new RangeError(
      `dedupeKey ${field} contains an instant: ${value}. ` +
        'A key derived from the clock makes one ongoing problem into a new ' +
        'problem on every pass.',
    )
  }
  if (scanNumbers && CLOCK_LIKE_NUMBER.test(value)) {
    throw new RangeError(
      `dedupeKey ${field} contains what looks like an epoch: ${value}.`,
    )
  }
}

/* ------------------------------------------------------------ causality -- */

/**
 * Which domains can be the ROOT of a problem in another domain.
 *
 * The chain from the brief, written down once: a laundry delay causes a stock
 * shortage causes a preparation risk causes an arrival risk. Four signals, one
 * incident, and the screen shows the root with the rest beneath it rather than
 * four alarms at 06:00 that look unrelated.
 *
 * The order inside each list is preference: the first upstream domain with a
 * signal on the same property wins. So a preparation risk that could be blamed
 * on either a shortage or an unaccepted job is blamed on the shortage, which
 * is the one further up the causal chain.
 *
 * The map is acyclic and `keys.test.ts` proves it, because a cycle here would
 * make `causedBy` a ring and the screen would render forever.
 */
export const CAUSE_SOURCES: Readonly<
  Record<AutopilotDomain, readonly AutopilotDomain[]>
> = {
  safety: [],
  guest_access: [],
  payment_risk: [],
  maintenance: [],
  staff: [],
  laundry: [],
  sales_opportunity: [],
  optimization: [],
  inventory: ['laundry'],
  preparation: ['inventory', 'laundry', 'maintenance', 'staff'],
  arrival_risk: [
    'safety',
    'maintenance',
    'inventory',
    'laundry',
    'preparation',
    'guest_access',
    'payment_risk',
    'staff',
  ],
}

/**
 * Attach each signal to the root it is downstream of.
 *
 * Scoped to a property, and to a property only. A shortage at Villa A does not
 * explain a preparation risk at Villa B, and a chain that crossed properties
 * would produce an incident tree nobody could act on. A signal with no
 * `propertyId` is about the organization as a whole and is linked to nothing —
 * which is honest: we do not know that it is downstream of anything.
 *
 * Signals that already carry a `causedBy` are left alone. A detector that
 * knows the specific row it is downstream of knows more than this function
 * can infer, and inference must never overwrite knowledge.
 */
export function linkCauses(signals: readonly Signal[]): Signal[] {
  const byDomain = new Map<AutopilotDomain, Signal[]>()
  for (const signal of signals) {
    const existing = byDomain.get(signal.domain)
    if (existing === undefined) byDomain.set(signal.domain, [signal])
    else existing.push(signal)
  }

  return signals.map((signal) => {
    if (signal.causedBy !== undefined) return signal
    if (signal.propertyId === null) return signal

    for (const upstream of CAUSE_SOURCES[signal.domain]) {
      const candidates = (byDomain.get(upstream) ?? [])
        .filter(
          (other) =>
            other.propertyId === signal.propertyId &&
            other.dedupeKey !== signal.dedupeKey,
        )
        // Sorted so the answer does not depend on the order the detectors
        // happened to run in. A cause that changes between two passes over
        // the same facts is a cause nobody believes.
        .sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1))

      const root = candidates[0]
      if (root !== undefined) return { ...signal, causedBy: root.dedupeKey }
    }
    return signal
  })
}
