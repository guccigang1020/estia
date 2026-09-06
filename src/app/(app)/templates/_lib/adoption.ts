/**
 * PURE. What it would take to put this template to work here.
 *
 * ── Why a path and not a button ───────────────────────────────────────────
 *
 * `0067_automation_rules.sql` gave the library per-organization state, so a
 * rule CAN now be switched on — at `/automations`, which owns that control.
 * What still does not exist is a runner: enabling records intent and nothing
 * fires by itself yet.
 *
 * This screen therefore still offers no button. Not because the write is
 * impossible, but because the write lives one screen away and duplicating it
 * here would be two controls for one piece of state. What it answers is the
 * question somebody actually has — would this rule do anything for me — and
 * the last step now points at where to act rather than at a missing table.
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
      title: 'הפעלת הכלל לארגון שלכם',
      met: null,
      detail:
        'הפעלה וכיבוי לכל ארגון בנפרד נעשים במסך האוטומציות. מה שעדיין אין הוא מריץ — הפעלה נרשמת ככוונה, ואף כלל אינו פועל מעצמו עדיין. ההרצה היבשה שם מראה מה הכלל היה עושה על הנתונים שלכם.',
    },
  ]
}
