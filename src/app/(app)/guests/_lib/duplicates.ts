/**
 * EXECUTION CONTEXT — SERVER ONLY. Finding two rows that might be one person.
 *
 * ══ WHAT THE DATABASE HAS ALREADY MADE IMPOSSIBLE ═══════════════════════════
 *
 * `guests_organization_phone_idx` is unique over `(organization_id,
 * phone_e164)` among live rows, so **two live guests cannot share a normalised
 * telephone number**. The strongest duplicate signal there is does not occur.
 *
 * That is worth saying plainly, because it decides what this file can look
 * for. What is left is the softer set, and every one of them is a suggestion:
 *
 *   · the same email address — which is a CANDIDATE key and never an identity
 *     (ח40-06): a couple booking two stays from one address is the ordinary
 *     case, not a duplicate;
 *   · a telephone whose last seven digits agree and whose prefix does not —
 *     the case ח40-03 documents, where one spelling carried a country code
 *     and the other did not;
 *   · a row whose telephone is null and whose name is close to another's,
 *     which on its own can never cross the threshold and is therefore only
 *     ever a "might be".
 *
 * ══ WHY THE PAIRS ARE BUCKETED RATHER THAN CROSS-MULTIPLIED ═════════════════
 *
 * Every guest against every other guest is a square, and a business with four
 * thousand customers is eight million comparisons on a page load. Rows are
 * bucketed by the two keys that could produce a match — normalised email, and
 * the last seven digits of the telephone — and only rows sharing a bucket are
 * scored. A pair that shares neither cannot reach 0.60 on a name alone, so the
 * buckets lose nothing: 0.12 is the whole of a name.
 *
 * ══ DOCUMENT NUMBERS ARE NOT READ ═══════════════════════════════════════════
 *
 * 🔒 `id_document_number` is in the §7.1 formula and is deliberately NOT
 * selected here. `docs/PERSONAL_DATA_INVENTORY.md` records that it sits in
 * plain text and is the most sensitive field in the database; a duplicates
 * screen that read it would be a standing reason to read it for every guest in
 * the business, every time somebody opened the page. The threshold is
 * reachable without it — 0.60 + 0.20 + 0.12 = 0.92 — and `MatchScore` reports
 * `documentsCompared: false` so the reader knows what the score did and did
 * not look at.
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'
import {
  POSSIBLE_MATCH_THRESHOLD,
  scoreMatch,
  suggestsMerge,
  type MatchScore,
  type MatchableGuest,
} from '@/lib/leads'
import {
  asNumber,
  asString,
  asStringOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'

/** How many guests one sweep looks at. The screen says when it hits this. */
export const DUPLICATE_SCAN_SIZE = 500

export interface DuplicateCandidate {
  left: CandidateGuest
  right: CandidateGuest
  score: MatchScore
  /** True at or above 0.85 — the product offers a merge (ח40-09). */
  suggested: boolean
}

export interface CandidateGuest extends MatchableGuest {
  version: number
  stayCountKnown: false
}

/**
 * Pairs worth a person's attention, strongest first.
 *
 * Returns `null` without `guest.view`. The scan reads names, telephone numbers
 * and email addresses across the whole customer list, so it is gated on the
 * grant for reading guests at all — and on nothing weaker, because a list of
 * "these two are probably the same person" is a summary of the customer list.
 */
export async function findDuplicateCandidates(
  db: Db,
  actor: Actor,
  organizationId: string,
): Promise<readonly DuplicateCandidate[] | null> {
  if (!holdsGrant(actor, 'guest.view')) return null

  const { data, error } = await db
    .from('guests')
    .select('id, full_name, phone_e164, email, version')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    // Merged rows are soft-deleted, so `deleted_at is null` already excludes
    // them; this says the same thing about a row that was merged and somehow
    // left live, which the `guests_merged_is_deleted` constraint forbids.
    .is('merged_into_guest_id', null)
    .order('created_at', { ascending: false })
    .limit(DUPLICATE_SCAN_SIZE)

  if (error) throw error

  const guests: CandidateGuest[] = toRows(data).map((row) => ({
    id: asString(row, 'id'),
    fullName: asStringOrNull(row, 'full_name') ?? '',
    phoneE164: asStringOrNull(row, 'phone_e164'),
    email: asStringOrNull(row, 'email'),
    version: asNumber(row, 'version'),
    stayCountKnown: false,
  }))

  const buckets = new Map<string, CandidateGuest[]>()
  const put = (key: string, guest: CandidateGuest) => {
    const bucket = buckets.get(key)
    if (bucket) bucket.push(guest)
    else buckets.set(key, [guest])
  }

  for (const guest of guests) {
    if (guest.email !== null && guest.email.trim() !== '') {
      put(`email:${guest.email.trim().toLowerCase()}`, guest)
    }
    if (guest.phoneE164 !== null) {
      const tail = guest.phoneE164.replace(/\D/g, '').slice(-7)
      if (tail.length === 7) put(`tail:${tail}`, guest)
    }
  }

  // Keyed by the ordered pair, because two guests can share both an email
  // bucket and a telephone bucket and must still be offered once.
  const pairs = new Map<string, DuplicateCandidate>()

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const [left, right] =
          bucket[i].id < bucket[j].id
            ? [bucket[i], bucket[j]]
            : [bucket[j], bucket[i]]
        const key = `${left.id}:${right.id}`
        if (pairs.has(key)) continue

        const score = scoreMatch(left, right)
        if (score.score < POSSIBLE_MATCH_THRESHOLD) continue

        pairs.set(key, { left, right, score, suggested: suggestsMerge(score) })
      }
    }
  }

  return [...pairs.values()].sort((a, b) => b.score.score - a.score.score)
}

/** True when the sweep saw the ceiling and there may be more behind it. */
export async function duplicateScanWasTruncated(
  db: Db,
  organizationId: string,
): Promise<boolean> {
  const { count, error } = await db
    .from('guests')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (error) throw error
  return (count ?? 0) > DUPLICATE_SCAN_SIZE
}
