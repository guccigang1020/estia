/**
 * PURE. What it would take to put this template to work here.
 *
 * ── Why a path and not a button ───────────────────────────────────────────
 *
 * There is no `automation_rules` table in any migration, and `library.ts` is
 * explicit that a template is a definition to be copied rather than a row to be
 * toggled. So "adopt" is not a write this deployment can perform, and a button
 * offering it would be the worst kind of lie — one that appears to work.
 *
 * What the product *can* do honestly is answer the question a person actually
 * has, which is not "may I click this" but "would this do anything for me". The
 * answer has three parts and they are checked in the order somebody would hit
 * them: the package, then the role, then the data. Each is answered from a
 * source that already exists — `ruleReadiness` for the first two, the
 * template's own `requiredFacts` for the third — and none of them is guessed.
 *
 * ── The order is load-bearing ─────────────────────────────────────────────
 *
 * Package first, because when the module is not bought the permission question
 * is moot and telling somebody to go and get a grant they already hold sends
 * them to an administrator who cannot help. `ruleReadiness` makes the same
 * choice for the same reason and returns `module_locked` as its own status
 * rather than folding it into `blocked`; this file follows it rather than
 * deciding again.
 */

import { entitlementLabel } from '@/components/nav/labels'
import {
  AUTOMATION_ENTITLEMENT,
  requiredFacts,
  type AutomationTemplate,
  type RuleReadiness,
} from '@/lib/automation'

import { actionGrantLabel, factLabel } from '../../automations/_lib/labels'

export interface AdoptionStep {
  /** What has to be true, as a short noun phrase. */
  title: string
  /**
   * Whether it is true here and now.
   *
   * `null` where the product genuinely cannot answer — the adoption step
   * itself, which needs storage that does not exist. A `false` there would read
   * as "you have failed a check", and nobody has.
   */
  met: boolean | null
  /** The consequence, in one sentence. Never a colour alone. */
  detail: string
}

export function adoptionSteps(
  template: AutomationTemplate,
  readiness: RuleReadiness,
): readonly AdoptionStep[] {
  const facts = requiredFacts(template)
  const moduleAvailable = readiness.status !== 'module_locked'

  return [
    {
      title: 'החבילה כוללת אוטומציות',
      met: moduleAvailable,
      detail: moduleAvailable
        ? 'החבילה של העסק כוללת את מודול האוטומציות, ולכן כללים יכולים לרוץ.'
        : `החבילה הנוכחית אינה כוללת את היכולת ״${entitlementLabel(AUTOMATION_ENTITLEMENT)}״. זו אינה שאלה של הרשאה — ההרשאות שלך תקינות.`,
    },
    {
      title: 'התפקיד שלך מרשה את הפעולות',
      // Asked only once the module is available. Under a plan lock every action
      // is refused on the plan and the grant answer is not meaningful.
      met: moduleAvailable ? readiness.missingGrants.length === 0 : null,
      detail: !moduleAvailable
        ? 'תיבדק אחרי שהמודול ייכלל בחבילה. כרגע אין מה לבדוק — שום פעולה לא תגיע לשלב ההרשאה.'
        : readiness.missingGrants.length === 0
          ? 'אתה מחזיק בכל ההרשאות שהפעולות בכלל הזה דורשות, ולכן הוא היה מתבצע במלואו.'
          : `חסרות לך: ${readiness.missingGrants.map(actionGrantLabel).join(', ')}. מנהל בארגון יכול להוסיף אותן.`,
    },
    {
      title: 'האירוע נושא את הנתונים שהתנאי בודק',
      // Facts are a property of the event, not of this reader, so this step is
      // a statement rather than a check. `met` is true when there is nothing to
      // carry, which is the common case and the honest reading of "no IF".
      met: facts.length === 0 ? true : null,
      detail:
        facts.length === 0
          ? 'לכלל הזה אין תנאי מסנן, ולכן הוא רץ בכל פעם שהאירוע קורה ואין נתון שחייב להגיע איתו.'
          : `התנאי נשען על ${facts.map(factLabel).join(', ')}. אם האירוע לא יישא את הנתון, התנאי ייחשב כלא־מתקיים והכלל לא יפעל — כך המנוע נכשל לצד הבטוח.`,
    },
    {
      title: 'העתקת הכלל לארגון',
      met: null,
      detail:
        'העתקה, עריכה וכיבוי לכל ארגון בנפרד דורשים טבלת כללים שעדיין אינה קיימת במוצר. עד אז הכלל רץ במצב שבו הוא נשלח, וההרצה היבשה במסך האוטומציות מראה מה הוא היה עושה על הנתונים שלך.',
    },
  ]
}
