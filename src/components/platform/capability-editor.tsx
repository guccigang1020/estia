import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { CapabilityState, ConsoleSubscription } from '@/lib/platform'
import type { QuotaKey } from '@/lib/plans/quota'

import { ENTITLEMENT_LABEL, QUOTA_LABEL } from './labels'

/**
 * The per-customer capability overrides.
 *
 * ══ THIS EDITS THE COLUMNS THE PRODUCT ITSELF READS ═══════════════════════
 *
 * `organization_subscriptions.entitlement_grants`,
 * `entitlement_revocations` and `limit_overrides` — the same three columns
 * `effectiveEntitlements()` and `effectiveLimits()` resolve a customer's
 * package from at runtime. There is no separate feature-flag table, and that
 * absence is the design: two tables answering "does this customer have the
 * website builder" is two answers, and a capability the console can set and
 * the product does not consult is worse than no console, because somebody will
 * set it and go home.
 *
 * ── Why every feature is listed, including the ones that are off ──────────
 *
 * A list of what is already enabled cannot be used to enable anything, and a
 * reader cannot tell a feature that is off from one the product does not have.
 * So the whole catalogue is shown with its origin beside it: in the package,
 * added for this customer, withdrawn for this customer, or absent.
 *
 * ── Three states for a limit, and they are all different ──────────────────
 *
 * A number is an override. The word "ללא הגבלה" is an explicit `null`, meaning
 * no ceiling. An EMPTY field is an absent key that falls through to the
 * package's own figure — which is not the same as zero and is not the same as
 * unlimited. `effectiveLimits()` was corrected once for exactly this: an
 * override carrying `undefined` overwrote a real figure, `checkQuota` compared
 * against nothing, and the customer was locked out of inviting staff.
 */
const LIMIT_KEYS: readonly QuotaKey[] = [
  'properties',
  'units',
  'members',
  'storageGb',
]

const ORIGIN_LABEL: Record<CapabilityState['origin'], string> = {
  plan: 'כלול בחבילה',
  granted: 'נוסף ללקוח הזה',
  revoked: 'נשלל מהלקוח הזה',
  absent: 'לא כלול',
  cancelled: 'המנוי בוטל',
}

export function CapabilityEditor({
  organizationId,
  capabilities,
  subscription,
  editable,
  action,
}: {
  organizationId: string
  capabilities: readonly CapabilityState[]
  subscription: ConsoleSubscription
  editable: boolean
  action: (form: FormData) => Promise<void>
}) {
  const granted = new Set(subscription.entitlementGrants)
  const revoked = new Set(subscription.entitlementRevocations)

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight">
          יכולות ומכסות ללקוח הזה
        </h2>
        <p className="text-sm text-muted-foreground">
          שלוש עמודות על שורת המנוי, ואותן שלוש שהמוצר עצמו קורא בזמן ריצה. אין
          כאן טבלת דגלים נפרדת בכוונה — שני מקורות לשאלה &quot;האם ללקוח הזה יש
          את בונה האתרים&quot; הם שתי תשובות, וביום שהן ייפרדו הקונסולה תציג אחת
          והמוצר יתנהג לפי השנייה.
        </p>
      </div>

      {subscription.status === 'cancelled' && (
        <p className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm">
          המנוי מבוטל, ולכן כל יכולת מלבד הליבה כבויה — ללא קשר לחבילה ולחריגות.
          זה מצב תשלום, לא שלילה שמישהו ביצע, והמסך מבחין בין השניים.
        </p>
      )}

      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="organizationId" value={organizationId} />

        <fieldset
          disabled={!editable}
          className="flex flex-col gap-4 disabled:opacity-70"
        >
          <legend className="sr-only">יכולות</legend>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                יכולות המוצר, מצבן אצל הלקוח הזה, והחריגות שאפשר להגדיר
              </caption>
              <thead>
                <tr className="border-b border-border bg-muted">
                  <th
                    scope="col"
                    className="px-4 py-2 text-start font-semibold"
                  >
                    יכולת
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-start font-semibold"
                  >
                    מצב
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-start font-semibold"
                  >
                    הוספה ללקוח
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-start font-semibold"
                  >
                    שלילה מהלקוח
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {capabilities.map((capability) => (
                  <tr key={capability.entitlement}>
                    <th
                      scope="row"
                      className="px-4 py-2 text-start font-medium"
                    >
                      {ENTITLEMENT_LABEL[capability.entitlement]}
                      <code
                        dir="ltr"
                        className="ms-2 text-xs text-muted-foreground"
                      >
                        {capability.entitlement}
                      </code>
                    </th>
                    <td className="px-4 py-2">
                      <Badge tone={capability.active ? 'brand' : 'neutral'}>
                        {capability.active ? 'פעילה' : 'כבויה'}
                      </Badge>
                      <span className="ms-2 text-xs text-muted-foreground">
                        {ORIGIN_LABEL[capability.origin]}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        name="grant"
                        value={capability.entitlement}
                        defaultChecked={granted.has(capability.entitlement)}
                        aria-label={`הוספת ${ENTITLEMENT_LABEL[capability.entitlement]}`}
                        className="size-4"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        name="revoke"
                        value={capability.entitlement}
                        defaultChecked={revoked.has(capability.entitlement)}
                        aria-label={`שלילת ${ENTITLEMENT_LABEL[capability.entitlement]}`}
                        className="size-4"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            סימון של אותה יכולת גם כהוספה וגם כשלילה נדחה. השלילה גוברת, כך
            שהצירוף הזה היה נקרא כשלילה בלבד — ומי שסימן את שניהם היה מאמין
            שההוספה נכנסה לתוקף.
          </p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {LIMIT_KEYS.map((key) => (
              <label key={key} className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{QUOTA_LABEL[key]}</span>
                <input
                  name={`limit.${key}`}
                  defaultValue={limitValue(subscription, key)}
                  placeholder="ריק = לפי החבילה"
                  className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                <span className="text-xs text-muted-foreground">
                  מספר, או <code dir="ltr">unlimited</code> ללא תקרה. שדה ריק
                  מוחק את החריגה ומחזיר את הלקוח לתקרת החבילה.
                </span>
              </label>
            ))}
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">
              נימוק (חובה, ונרשם ביומן של הלקוח)
            </span>
            <textarea
              name="reason"
              required
              rows={2}
              placeholder="לדוגמה: עסקה מיוחדת שסוכמה במכירה — Pro עם 25 יחידות"
              className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </label>
        </fieldset>

        {editable ? (
          <div>
            <Button type="submit">שמירת היכולות</Button>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
            התפקיד שלך אינו כולל{' '}
            <code dir="ltr">platform.feature_flag.manage</code>, ולכן הטופס מוצג
            לקריאה בלבד. הפעולה נבדקת שוב בשרת ושוב במסד הנתונים, ולא מסתמכת על
            הכפתור הזה.
          </p>
        )}
      </form>
    </section>
  )
}

/**
 * What the field starts with.
 *
 * An absent key renders as an EMPTY field, never as the package's number:
 * pre-filling the plan's figure would turn "no override" into an override the
 * moment somebody pressed save without touching it.
 */
function limitValue(subscription: ConsoleSubscription, key: QuotaKey): string {
  if (!Object.prototype.hasOwnProperty.call(subscription.limitOverrides, key)) {
    return ''
  }

  const value = subscription.limitOverrides[key]
  if (value === null) return 'unlimited'
  return typeof value === 'number' ? String(value) : ''
}
