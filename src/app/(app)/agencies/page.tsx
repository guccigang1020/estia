import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { PlanLock } from '@/components/distribution/plan-lock'
import { Money } from '@/components/finance/money'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { COMMISSION_BASE_LABEL } from '@/lib/contracts/states'
import { formatDayMonthYear, localDate } from '@/lib/booking'
import { agencyResource, formatIsraeliPhone } from '@/lib/agents'
import { can } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { AgencyContactForm } from './_components/agency-contact-form'
import { AgencyStatusControl } from './_components/agency-status-control'
import { AgencyTermsForm } from './_components/agency-terms-form'

import { shellContext } from '../_lib/context'
import { requireDistributionGrant } from '../agents/_lib/gate'
import {
  AGENCY_MEMBER_ROLE_LABEL,
  AGENCY_MEMBER_STATUS_LABEL,
  AGENCY_STATUS_LABEL,
  AGREEMENT_STATUS_LABEL,
  agreementTone,
  type AgencyMemberRole,
  type AgencyMemberStatus,
  type AgencyStatus,
  type AgreementStatus,
} from '../agents/_lib/labels'
import {
  countAgreements,
  listAgencies,
  type AgencyListItem,
  type AgreementTerms,
} from './_lib/queries'

export const metadata: Metadata = { title: 'סוכנויות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The agencies this business sells
 * through, and on what terms.
 *
 * AN AGENCY IS NOT A SUB-RECORD OF THIS BUSINESS. `agencies` carries no
 * `organization_id` — a holiday agency sells for several businesses at once, so
 * ownership is the wrong model and the relationship is the agreement. That is
 * why this screen is organised as *agreements with agencies* rather than as a
 * directory: an agency with no agreement here is not this business's agency and
 * does not appear, and the same agency's terms with a competitor are neither
 * readable nor implied.
 *
 * WHY THE STATUS AND THE LIVENESS ARE SHOWN SEPARATELY. `isAgreementActive`
 * decides against today's date every time it is asked, because an agreement
 * whose end date passed last night is over whether or not a job has run to say
 * so — a background job that stops running must not be able to keep granting
 * reach it was supposed to remove. So an agreement can read "בתוקף" in its
 * status column and "לא בתוקף היום" beside it, and that is not a contradiction:
 * it is a notice period, or a start date that has not arrived.
 *
 * A COMMISSION MAY BE OWED TO A COMPANY. `commissions.agent_user_id` is
 * nullable and `commissions_has_a_payee` requires an agent *or* an agency,
 * because the agency keeps the commercial relationship when the individual
 * leaves. The money on this screen is therefore read by `agency_id` alone —
 * grouping it by the person would drop exactly the rows an agency screen exists
 * to show, and would do it silently.
 *
 * ENDING AN AGREEMENT DELETES NOTHING, and the screen says so where a
 * terminated one appears. The commissions written under it are still owed, the
 * bookings it produced are still attributed to it, and a report comparing direct
 * against agency sales must still be able to read it.
 *
 * GATING. `agency.manage`, which is mapped to `agent_network` — so a Basic
 * organization gets the upgrade screen and not a permission refusal. `can()` is
 * asked again per read inside the query, and the money is narrowed a second time
 * per commission row with `family: 'finance'`, which is what makes the figure
 * true for whoever is reading it rather than true for an owner.
 *
 * ── THE SCREEN CAN NOW WRITE, AND WHAT IT REFUSES IT EXPLAINS ─────────────
 *
 * Until `0070_agencies_write_path.sql` this screen was read-only with no stated
 * reason, over a table nothing in the product could insert into. It now creates
 * an agency, corrects its details, sets its commission terms and ends the
 * relationship — through the operations in `src/lib/agents/agency-operations.ts`
 * and no other path.
 *
 * Three controls are conditional, and each absence is a sentence rather than a
 * gap:
 *
 *   · **Editing the details** appears only for an agency **nobody from the
 *     agency manages**. `agencies_update` says so, and it says so for a reason
 *     worth keeping: an agency is not this business's sub-record, and once a
 *     real manager exists the details are theirs. A business that pressed a
 *     hidden button would have met an UPDATE matching zero rows, which
 *     succeeds — the worst possible failure.
 *   · **The terms form** needs `agent_agreement.manage` to write and
 *     `agent_agreement.view` to read the eligibility conditions it would
 *     otherwise overwrite with a default. Without the second it is hidden, not
 *     pre-filled with a guess.
 *   · **Ending the relationship** appears where there is a live agreement, and
 *     reopening where there is an ended one and no live one in the way.
 */
export default async function AgenciesPage() {
  const [access, context] = await Promise.all([
    requireDistributionGrant('agency.manage'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="סוכנויות אינן כלולות בחבילה שלך"
        body="סוכנות היא צד מסחרי שמוכר עבורך: הסכם עם תאריכים ועמלה, אנשים שמוכרים תחתיו, וחוב שממשיך להתקיים גם אחרי שההסכם נגמר."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  // Today at the property, not `new Date().toISOString().slice(0, 10)`: an
  // agreement that ends today is live until midnight in Israel, and slicing a
  // UTC instant would end it three hours early for anybody reading after 21:00.
  const today = localDate(new Date())

  let agencies: readonly AgencyListItem[] = []
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[agencies, total] = await Promise.all([
      listAgencies({
        db,
        actor,
        organizationId: actor.organizationId,
        on: today,
      }),
      countAgreements(db, actor.organizationId),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const liveCount = agencies.filter((agency) =>
    agency.agreements.some((agreement) => agreement.live),
  ).length

  // Creating an agency writes two rows and needs the grant for each: the agency
  // itself, and the agreement that makes it visible. Naming both here is what
  // keeps a control on screen from promising something the operation refuses.
  const mayWriteTerms = can(
    actor,
    'agent_agreement.manage',
    agencyResource(actor.organizationId),
  )

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          סוכנויות
        </h1>
        <p className="text-muted-foreground">
          {total === 0
            ? 'עוד לא נחתם הסכם עם סוכנות.'
            : `${total === 1 ? 'הסכם אחד' : `${total} הסכמים`} עם ${agencies.length === 1 ? 'סוכנות אחת' : `${agencies.length} סוכנויות`}, מתוכן ${liveCount} בתוקף היום.`}{' '}
          סוכנות אינה שייכת לעסק אחד — היא מוכרת עבור כמה עסקים, ומה שמקשר אותה
          אליך הוא ההסכם. סיום הסכם מפסיק את הגישה ולא מוחק דבר.
        </p>
      </header>

      {mayWriteTerms ? (
        <Disclosure summary="הוסף סוכנות">
          <p className="mb-4 text-sm text-muted-foreground">
            סוכנות נרשמת פעם אחת ומוכרת עבור כמה עסקים. מה שמקשר אותה אליך הוא
            ההסכם, ולכן היא נוצרת יחד איתו — רשומה בלי הסכם אינה גלויה לאף אחד,
            כולל לך.
          </p>
          <AgencyContactForm mode="create" />
        </Disclosure>
      ) : (
        <p className="text-sm text-muted-foreground">
          אפשר לצפות בסוכנויות ולא להוסיף אחת: הקמת סוכנות כותבת גם את ההסכם
          איתה, וזו הרשאת <code dir="ltr">agent_agreement.manage</code> — מי
          שקובע את מחיר המכירה.
        </p>
      )}

      {failure ? (
        <ActionError error={failure.error} />
      ) : agencies.length === 0 ? (
        <EmptyState
          illustration="team"
          title="עוד לא עובדים עם סוכנות"
          body="סוכנות מוכרת עבורך תחת הסכם: אחוז עמלה, בסיס חישוב, תאריכים ותנאי תשלום. הסוכנים שלה נכנסים עם ההרשאות שאתה קובע לכל אחד מהם בנפרד — ההסכם קובע את הכסף, לא את מה שהם רואים."
        />
      ) : (
        <div className="flex flex-col gap-5">
          {agencies.map((agency) => (
            <AgencyCard
              key={agency.id}
              agency={agency}
              mayWriteTerms={mayWriteTerms}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A control that is closed until somebody wants it.
 *
 * `<details>` rather than a dialog or a state hook: it works before hydration,
 * it is a disclosure to a screen reader without a single aria attribute, and it
 * keeps this file a server component. The marker is moved to the inline end,
 * which is the left edge in Hebrew.
 */
function Disclosure({
  summary,
  children,
}: {
  summary: string
  children: React.ReactNode
}) {
  return (
    <details className="rounded-xl border border-border bg-surface">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-foreground marker:content-none">
        {summary}
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  )
}

/* --------------------------------------------------------------- parts -- */

function AgencyCard({
  agency,
  mayWriteTerms,
}: {
  agency: AgencyListItem
  mayWriteTerms: boolean
}) {
  const live = agency.agreements.some((agreement) => agreement.live)

  // The agreement the terms form edits: the one that is not over. `live` is
  // computed against today's date and can honestly be false for an active
  // agreement whose window has not opened — that one is still the row to edit,
  // which is why this looks at the stored status and not at `live`.
  const openAgreement =
    agency.agreements.find((agreement) => agreement.status === 'active') ?? null
  const endedAgreement = agency.agreements.some(
    (agreement) => agreement.status === 'terminated',
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle as="h2">{agency.name}</CardTitle>
          <Badge tone={agreementTone(live)}>
            {live ? 'הסכם בתוקף היום' : 'אין הסכם בתוקף היום'}
          </Badge>
          <Badge>{statusLabel(agency.status)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {agency.taxId !== null && <>ח.פ. {agency.taxId}</>}
          {agency.contactPhoneE164 !== null && (
            <>
              {agency.taxId !== null && ' · '}
              <span dir="ltr">
                {formatIsraeliPhone(agency.contactPhoneE164)}
              </span>
            </>
          )}
          {agency.contactEmail !== null && (
            <>
              {' · '}
              <span dir="ltr">{agency.contactEmail}</span>
            </>
          )}
        </p>
      </CardHeader>

      {/* ------------------------------------------------------ money -- */}
      <dl className="mt-5 grid gap-4 sm:grid-cols-3">
        <Figure label="עמלות שנרשמו" value={agency.commissionCount} />
        <Figure
          label="סך העמלות"
          value={<Money agorot={agency.owedAgorot} emphasis />}
        />
        <Figure
          label="עדיין לא שולם"
          value={<Money agorot={agency.unpaidAgorot} emphasis />}
        />
      </dl>
      {agency.owedAgorot === null && (
        <p className="mt-2 text-xs text-muted-foreground">
          סכומי העמלות אינם גלויים לך. זו אינה טענה שאין עמלות.
        </p>
      )}

      {/* ------------------------------------------------- agreements -- */}
      <section className="mt-6 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground">הסכמים</h3>
        <ul className="flex flex-col divide-y divide-border">
          {agency.agreements.map((agreement) => (
            <li key={agreement.id} className="py-3">
              <Agreement agreement={agreement} />
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------------------------------------------- members -- */}
      <section className="mt-6 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          מי מוכר תחת הסוכנות
        </h3>
        {agency.members === null ? (
          <p className="text-sm text-muted-foreground">
            רשימת האנשים אינה גלויה לך.
          </p>
        ) : agency.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            לסוכנות הזו אין אנשים רשומים. ההסכם עומד בפני עצמו — עמלה יכולה
            להיות חייבת לסוכנות גם בלי אדם מסוים מאחוריה.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {agency.members.map((member) => (
              <li
                key={member.userId}
                className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm"
              >
                <span className="font-medium text-foreground">
                  {member.displayName ?? 'אדם שאינו חבר בארגון שלך'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {memberRoleLabel(member.role)} ·{' '}
                  {memberStatusLabel(member.status)} · מאז{' '}
                  {formatDayMonthYear(member.joinedOn.slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {agency.note !== null && (
        <p className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
          {agency.note}
        </p>
      )}

      {agency.status === 'inactive' && agency.deactivationReason !== null && (
        <p className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
          סומנה כלא פעילה. נימוק: {agency.deactivationReason}
        </p>
      )}

      {/* ------------------------------------------------- what can change -- */}
      <section className="mt-6 flex flex-col gap-3 border-t border-border pt-5">
        {!agency.visible ? (
          <p className="text-sm text-muted-foreground">
            רשומת הסוכנות עצמה אינה גלויה לך, ולכן אי אפשר לערוך אותה מכאן.
            ההסכם שלך איתה קיים והעמלות שנרשמו תחתיו עומדות בעינן.
          </p>
        ) : (
          <>
            {agency.unclaimed ? (
              <Disclosure summary="ערוך את פרטי הסוכנות">
                <AgencyContactForm
                  mode="edit"
                  agencyId={agency.id}
                  version={agency.version}
                  initial={{
                    name: agency.name,
                    taxId: agency.taxId ?? '',
                    // As typed, not the generated E.164 key: putting the
                    // normalised form back in the field would rewrite what a
                    // person entered the first time they touched an unrelated
                    // field.
                    contactPhone: agency.contactPhone ?? '',
                    contactEmail: agency.contactEmail ?? '',
                    addressLine1: agency.addressLine1 ?? '',
                    city: agency.city ?? '',
                    country: agency.country,
                    note: agency.note ?? '',
                  }}
                />
              </Disclosure>
            ) : (
              <p className="text-sm text-muted-foreground">
                לסוכנות הזו יש מנהל משלה, ולכן פרטי הקשר שלה נערכים על ידה. זו
                אינה רשומה של העסק שלך — היא מוכרת גם עבור אחרים, ומה ששייך לך
                הוא ההסכם.
              </p>
            )}

            {mayWriteTerms &&
              (agency.eligibility === null ? (
                <p className="text-sm text-muted-foreground">
                  אינך רשאי לקרוא את כללי העמלה, ולכן טופס התנאים מוסתר. שמירה
                  בלי לראות את תנאי הזכאות הקיימים הייתה מוחקת אותם לטובת ברירת
                  מחדל — וזה ההבדל בין תשלום על שהיות שהתקיימו לבין תשלום על
                  שהיות שאולי לא יתקיימו.
                </p>
              ) : openAgreement === null ? (
                <p className="text-sm text-muted-foreground">
                  אין הסכם פתוח שאפשר לעדכן את תנאיו. אפשר להחזיר את ההסכם
                  האחרון לתוקף ואז לעדכן.
                </p>
              ) : (
                <Disclosure summary="עדכן את תנאי העמלה">
                  <AgencyTermsForm
                    agencyId={agency.id}
                    agencyName={agency.name}
                    version={openAgreement.version}
                    initial={{
                      kind: openAgreement.rule?.kind ?? 'none',
                      percent:
                        openAgreement.rule?.kind === 'percentage'
                          ? openAgreement.rule.percent
                          : null,
                      amountAgorot:
                        openAgreement.rule?.kind === 'fixed'
                          ? openAgreement.rule.amountAgorot
                          : null,
                      base: openAgreement.base,
                      eligibility: agency.eligibility,
                      activeFrom: openAgreement.activeFrom,
                      activeUntil: openAgreement.activeUntil,
                      paymentTermsDays: openAgreement.paymentTermsDays,
                      note: openAgreement.note,
                    }}
                  />
                </Disclosure>
              ))}

            <AgencyStatusControl
              agencyId={agency.id}
              agencyName={agency.name}
              hasLiveAgreement={openAgreement !== null}
              isInactive={agency.status === 'inactive'}
              canReactivate={openAgreement === null && endedAgreement}
            />
          </>
        )}
      </section>
    </Card>
  )
}

/**
 * One agreement: its money, its window, and whether it is live today.
 *
 * The rule is rendered from the union rather than from a percent field, because
 * `none` is a real arrangement — an agency that brings business under some other
 * consideration — and is not the same as zero per cent. A rule that could not be
 * rebuilt says so instead of rendering blank.
 */
function Agreement({ agreement }: { agreement: AgreementTerms }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">
          {ruleText(agreement)}
        </span>
        <span className="text-sm text-muted-foreground">
          מתוך {COMMISSION_BASE_LABEL[agreement.base]}
        </span>
        <Badge tone={agreementTone(agreement.live)}>
          {agreement.live ? 'בתוקף היום' : 'לא בתוקף היום'}
        </Badge>
        <Badge>{agreementStatusLabel(agreement.status)}</Badge>
      </div>

      <span className="text-xs text-muted-foreground">
        מ־{formatDayMonthYear(agreement.activeFrom)}
        {agreement.activeUntil === null
          ? ' · ללא תאריך סיום'
          : ` עד ${formatDayMonthYear(agreement.activeUntil)}`}
        {' · '}תשלום תוך {agreement.paymentTermsDays} יום מאישור העמלה
      </span>

      {/* The status and the computed answer disagreeing is a fact, not a bug,
          and the reader is told which of the two reasons applies. */}
      {agreement.status === 'active' && !agreement.live && (
        <span className="text-xs text-accent-foreground">
          ההסכם מסומן כפעיל אך אינו בתוקף היום — התאריך של היום מחוץ לחלון
          שנקבע. התוקף נבדק מול התאריך בכל פנייה, ולא נקרא מהסטטוס.
        </span>
      )}

      {agreement.terminatedOn !== null && (
        <span className="text-xs text-muted-foreground">
          הסתיים ב־{formatDayMonthYear(agreement.terminatedOn.slice(0, 10))}
          {agreement.terminationReason !== null && (
            <> · {agreement.terminationReason}</>
          )}
          . העמלות שנכתבו תחתיו עדיין חייבות, וההזמנות עדיין מיוחסות אליו.
        </span>
      )}

      {agreement.note !== null && (
        <span className="text-xs text-muted-foreground">{agreement.note}</span>
      )}
    </div>
  )
}

function ruleText(agreement: AgreementTerms): string {
  const rule = agreement.rule
  if (rule === null) return 'תנאי העמלה אינם קריאים — יש לבדוק את הרשומה'

  switch (rule.kind) {
    case 'none':
      return 'ללא עמלה'
    case 'percentage':
      return `${rule.percent}% עמלה`
    case 'fixed':
      return 'סכום קבוע לכל הזמנה'
    case 'tiered':
      return `עמלה מדורגת (${rule.tiers.length} מדרגות)`
  }
}

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-lg font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  )
}

/**
 * The three fallbacks below print the raw value rather than inventing a Hebrew
 * name for one this file does not know.
 *
 * The columns are constrained by CHECK in 0015, so an unknown value means the
 * schema moved and the label table did not — which a reader should see as an
 * unfamiliar word, not as a confident mistranslation.
 */
function statusLabel(value: string): string {
  return value in AGENCY_STATUS_LABEL
    ? AGENCY_STATUS_LABEL[value as AgencyStatus]
    : value
}

function memberRoleLabel(value: string): string {
  return value in AGENCY_MEMBER_ROLE_LABEL
    ? AGENCY_MEMBER_ROLE_LABEL[value as AgencyMemberRole]
    : value
}

function memberStatusLabel(value: string): string {
  return value in AGENCY_MEMBER_STATUS_LABEL
    ? AGENCY_MEMBER_STATUS_LABEL[value as AgencyMemberStatus]
    : value
}

function agreementStatusLabel(value: string): string {
  return value in AGREEMENT_STATUS_LABEL
    ? AGREEMENT_STATUS_LABEL[value as AgreementStatus]
    : value
}
