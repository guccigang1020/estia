/**
 * EXECUTION CONTEXT — SERVER ONLY. Retired, and redirecting.
 *
 * This screen read an owner as a MEMBERSHIP holding the `property_owner`
 * role. `/owners` reads an owner as an outside party with a dated share of a
 * property, who in most businesses never signs in at all — and only that
 * second reading can carry a statement, a payout or a balance.
 *
 * Two owner screens backed by two different ideas of what an owner is would
 * disagree within a week, and the disagreement would be about money. So this
 * one redirects rather than lingering: a permanent redirect, because the
 * answer will not change back, and a redirect rather than a deletion because
 * somebody has this URL in a bookmark.
 */

import { permanentRedirect } from 'next/navigation'

export default function RetiredOwnersPage(): never {
  permanentRedirect('/owners')
}
