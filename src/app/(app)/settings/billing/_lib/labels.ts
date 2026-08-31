/**
 * Hebrew wording for the four quotas, and the two sentences a crossed line can
 * produce.
 *
 * WHAT IS NOT HERE. `ENTITLEMENT_LABELS` is in `src/components/nav/labels.ts`
 * and is imported from there by this module's screen. A second Hebrew name for
 * `owner_portal` would disagree with the dashboard's within a month.
 *
 * ── The distinction this file encodes ─────────────────────────────────────
 *
 * `QUOTA_BLOCKS_ACTION` in `src/lib/plans/quota.ts` decides which quotas refuse
 * an action and which only warn, and it gives the test: would refusing it stop
 * the business serving a guest today? Properties and units warn; members and
 * storage refuse. Those are different events and they must not share a
 * sentence — "you are over your allowance" tells an owner nothing about whether
 * their receptionist can still check somebody in this afternoon.
 *
 * So there are two wordings per quota and the caller picks by `blocks`, which
 * `quotaLines` already carries on the row. The consequence is stated in the
 * words of the thing that stops working, not as "an action will be blocked" —
 * a customer over their member limit needs to read that they cannot invite
 * anybody, not that a policy has been triggered.
 */

import type { QuotaKey } from '@/lib/plans/quota'

/** What the limit counts. */
export const QUOTA_LABEL: Record<QuotaKey, string> = {
  properties: 'נכסים',
  units: 'יחידות',
  members: 'חברי צוות פעילים',
  storageGb: 'שטח אחסון',
}

/** How a figure is read: a count, or gigabytes. */
export const QUOTA_UNIT: Record<QuotaKey, string> = {
  properties: '',
  units: '',
  members: '',
  storageGb: 'GB',
}

/** What each limit is actually measuring, said once. */
export const QUOTA_MEANING: Record<QuotaKey, string> = {
  properties: 'נכסים שלא נמחקו. נכס שנסגר אינו תופס מכסה.',
  units:
    'יחידות שאפשר להזמין, בכל הנכסים של הארגון — לא רק בנכס שנבחר בראש המסך.',
  members: 'חברות פעילה בלבד. הזמנה שלא אושרה אינה מושב, וגם לא מי שהוסר.',
  storageGb: 'לא נמדד.',
}

/**
 * What happens when the line is crossed.
 *
 * The blocking wording names the action that stops. The warning wording says
 * plainly that nothing stops — because the alternative reading, "over your
 * allowance", is what makes an owner panic on a Friday afternoon about a
 * check-in that is going to work perfectly well.
 */
export const QUOTA_OVERAGE_CONSEQUENCE: Record<
  QuotaKey,
  { blocking: string; warning: string }
> = {
  properties: {
    blocking: 'הוספת נכס תיחסם.',
    warning:
      'שום דבר לא נחסם. אפשר להמשיך לעבוד, להוסיף הזמנות ולקבל אורחים כרגיל — המכסה חורגת והמוצר לא יעצור אתכם באמצע היום.',
  },
  units: {
    blocking: 'הוספת יחידה תיחסם.',
    warning:
      'שום דבר לא נחסם. עסק לא אמור להיתקע בצ׳ק-אין בגלל יחידה שנוספה מעבר למכסה, ולכן ההודעה הזו היא התראה ולא סירוב.',
  },
  members: {
    blocking:
      'לא תוכלו להזמין חבר צוות נוסף עד לשדרוג. מי שכבר בארגון ממשיך לעבוד כרגיל — החסימה היא על הוספה בלבד.',
    warning: 'שום דבר לא נחסם.',
  },
  storageGb: {
    blocking: 'העלאת קבצים נוספים תיחסם עד לשדרוג.',
    warning: 'שום דבר לא נחסם.',
  },
}

/**
 * Why a quota's ceiling is refused rather than merely flagged, in one line.
 *
 * Shown beside the limit itself so an owner can see the rule before they cross
 * it, rather than discovering it at the moment it stops them.
 */
export function quotaPolicyLine(key: QuotaKey, blocks: boolean): string {
  return blocks
    ? `חריגה כאן חוסמת פעולה: ${QUOTA_OVERAGE_CONSEQUENCE[key].blocking}`
    : 'חריגה כאן מתריעה בלבד ואינה חוסמת שום פעולה.'
}
