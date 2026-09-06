/**
 * What can be done about a shortage — and only what this organization can
 * actually do.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * An action is offered only when the capability behind it is on. Offering
 * "accelerate the laundry" to a business whose laundry module is off, or
 * "transfer from another property" to a business with one villa, is worse than
 * offering nothing: the person clicks, the product refuses, and they stop
 * trusting the whole screen. So every action names the capability it needs and
 * `buildActions` filters on it.
 *
 * ── Nothing here performs anything ────────────────────────────────────────
 *
 * These are proposals with destinations. Two of them —
 * `order_laundry` and `accelerate_laundry` — deliberately point at a screen
 * this module does not own, because the laundry domain is a different worker's
 * and the forecast must not reach into it. `transfer_from_property` is a
 * suggestion for the same reason the migration makes it one: taking another
 * property's working stock without asking solves one shortage by creating
 * another.
 *
 * `ignore` carries a reason and is not "dismiss". A shortage waved away
 * without a sentence is a shortage that reappears tomorrow and gets waved away
 * again; the reason is what lets somebody ask later why nobody ordered towels.
 */

import type {
  ForecastRow,
  InventoryCapabilities,
  InventorySettings,
  ShortageAction,
  ShortageActionKind,
} from './types'

export const SHORTAGE_ACTION_LABEL: Readonly<
  Record<ShortageActionKind, string>
> = {
  order_laundry: 'פתח הזמנת כביסה',
  accelerate_laundry: 'האץ כביסה קיימת',
  transfer_from_property: 'הצע העברה מנכס אחר',
  purchase_request: 'פתח בקשת רכש',
  adjust_buffer: 'עדכן מלאי ביטחון',
  mark_corrected: 'סמן כתוקן',
  ignore: 'התעלם עם נימוק',
}

export interface BuildActionsInput {
  row: ForecastRow
  capabilities: InventoryCapabilities
  settings: InventorySettings
}

/**
 * The actions this shortage, in this organization, can be answered with.
 *
 * Ordered by how much they cost the business, cheapest first: moving stock
 * that already exists before buying more, and buying more before shrugging.
 */
export function buildActions(
  input: BuildActionsInput,
): readonly ShortageAction[] {
  const { row, capabilities } = input
  const actions: ShortageAction[] = []

  // Only when there is something in the wash to hurry. `circulation` is the
  // clean/dirty/laundry loop; without it the product has no idea whether
  // anything is out at all, and "accelerate" would be advice about nothing.
  if (capabilities.circulation) {
    actions.push({
      kind: 'accelerate_laundry',
      label: SHORTAGE_ACTION_LABEL.accelerate_laundry,
      detail:
        `אם יש מחזור כביסה פתוח שחוזר אחרי ${row.date}, הקדמה שלו סוגרת את ` +
        `הפער של ${row.shortage || row.safetyBuffer - row.closingClean} יחידות בלי לקנות דבר.`,
      href: '/laundry',
      requires: 'circulation',
    })

    actions.push({
      kind: 'order_laundry',
      label: SHORTAGE_ACTION_LABEL.order_laundry,
      detail:
        'שליחת מה שמלוכלך עכשיו, כדי שיחזור נקי לפני התאריך. הזמנה נשלחת ' +
        'רק אחרי אישור — היא הודעה בשם העסק לגורם חיצוני.',
      href: '/laundry',
      requires: 'circulation',
    })
  }

  if (capabilities.transfers) {
    actions.push({
      kind: 'transfer_from_property',
      label: SHORTAGE_ACTION_LABEL.transfer_from_property,
      detail:
        'הצעה בלבד. העברה יוצאת מהמחסן של נכס אחר ולכן דורשת אישור — פתרון ' +
        'מחסור אחד על חשבון נכס אחר איננו פתרון.',
      href: `/inventory/shortages?item=${encodeURIComponent(row.itemId)}`,
      requires: 'transfers',
    })
  }

  if (capabilities.procurement) {
    actions.push({
      kind: 'purchase_request',
      label: SHORTAGE_ACTION_LABEL.purchase_request,
      detail:
        `בקשת רכש של ${Math.max(1, row.shortage)} יחידות, שתגיע לפני ` +
        `${row.date}. הבקשה נרשמת כאישור שממתין להחלטה ואינה מזמינה דבר ` +
        `בעצמה.`,
      href: '/approvals',
      requires: 'procurement',
    })
  }

  // Always available while the module is on: the buffer is the organization's
  // own number and a manager is entitled to change it. Offered second-to-last
  // deliberately — raising the floor is a real answer to a real risk, and
  // lowering it to silence a warning is not, which is why it goes to a screen
  // that shows what it affects rather than being a one-click dismissal.
  if (capabilities.enabled) {
    actions.push({
      kind: 'adjust_buffer',
      label: SHORTAGE_ACTION_LABEL.adjust_buffer,
      detail:
        `מלאי הביטחון הנוכחי לפריט הוא ${row.safetyBuffer}. שינוי שלו משנה ` +
        'את כל ההתראות מסוג זה, לא רק את זו.',
      href: '/inventory/settings',
      requires: 'enabled',
    })
  }

  // A count that was simply wrong. Ends in a compensating movement, never in
  // an edit of the quantity — 0011 is explicit that the ledger is the number.
  actions.push({
    kind: 'mark_corrected',
    label: SHORTAGE_ACTION_LABEL.mark_corrected,
    detail:
      'הספירה הייתה שגויה. נרשמת תנועת תיקון ביומן — הכמות עצמה לעולם ' +
      'אינה נערכת ידנית.',
    href: '/inventory/adjustments',
    requires: null,
  })

  actions.push({
    kind: 'ignore',
    label: SHORTAGE_ACTION_LABEL.ignore,
    detail:
      'ההתראה נסגרת עם נימוק שנשמר. בלי נימוק אי אפשר לענות מאוחר יותר על ' +
      'השאלה למה איש לא הזמין מגבות.',
    href: null,
    requires: null,
  })

  return actions
}

/**
 * The one worth putting on the button.
 *
 * Cheapest first, and it is the order in which the list was built — so the
 * suggestion is the head of the list rather than a second ranking that could
 * disagree with it.
 */
export function suggestedActionFrom(
  actions: readonly ShortageAction[],
): ShortageActionKind | null {
  const first = actions.find(
    (action) => action.kind !== 'mark_corrected' && action.kind !== 'ignore',
  )
  return first?.kind ?? actions[0]?.kind ?? null
}

/**
 * Is this action offerable at all, for these capabilities?
 *
 * Exported so the screens and the write path ask one question. A form that
 * rendered a button the action then refused is the drift this prevents.
 */
export function actionIsAvailable(
  kind: ShortageActionKind,
  capabilities: InventoryCapabilities,
): boolean {
  switch (kind) {
    case 'order_laundry':
    case 'accelerate_laundry':
      return capabilities.circulation
    case 'transfer_from_property':
      return capabilities.transfers
    case 'purchase_request':
      return capabilities.procurement
    case 'adjust_buffer':
      return capabilities.enabled
    case 'mark_corrected':
    case 'ignore':
      return true
  }
}
