/**
 * Hebrew wording for the two vocabularies the product has never had to print.
 *
 * WHAT IS NOT HERE, AND WHY. `BOOKING_STATUS_LABEL` is in
 * `src/lib/booking/state-machine.ts`, `TASK_STATUS_LABEL` in
 * `src/components/preparation/task-status.tsx`, `PAYMENT_STATUS_LABEL` in
 * `src/lib/finance` and `PAYMENT_ATTENTION_LABEL` in
 * `src/app/(app)/finance/_lib/labels.ts`. Every screen in this directory
 * imports them from there. Restating any of them would be a second Hebrew name
 * for a state that already has one, and the two would disagree the first time
 * somebody edited one.
 *
 * `approvals` is the one table on the action centre whose enums nothing has
 * ever rendered, so its wording is written here — once — with a totality test
 * beside it. `Record<ApprovalType, string>` is total over the frozen tuple in
 * `src/lib/contracts/states.ts`, so adding a member to `APPROVAL_TYPES` fails
 * the build here rather than shipping `availability_override` at an owner.
 */

import type { ApprovalStatus, ApprovalType } from '@/lib/contracts/states'

/** `public.approval_type`, 0011. What the exception is about. */
export const APPROVAL_TYPE_LABEL: Record<ApprovalType, string> = {
  discount: 'הנחה מעל התקרה',
  refund: 'החזר כספי',
  expense: 'הוצאה מעל התקרה',
  maintenance: 'עבודת תחזוקה',
  agent_booking: 'הזמנה שנמכרה על ידי סוכן',
  owner_request: 'בקשה של בעל הנכס',
  price_override: 'חריגה ממחירון',
  availability_override: 'פתיחת תאריך חסום',
}

/**
 * `public.approval_status`, 0011.
 *
 * `expired` is worded as a fact about the request and not about the person:
 * nobody answered in time, and the sale it was holding open is no longer held.
 * `withdrawn` is the requester taking it back, which is a different event and
 * must not read as a refusal.
 */
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  requested: 'ממתינה להחלטה',
  approved: 'אושרה',
  rejected: 'נדחתה',
  expired: 'פגה בלי מענה',
  withdrawn: 'בוטלה על ידי המבקש',
}
