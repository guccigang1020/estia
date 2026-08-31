import type { Metadata } from 'next'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import {
  Cell,
  DataTable,
  Row,
  RowHeader,
} from '@/components/management/data-table'
import { Notice } from '@/components/management/notice'
import { PageHeader } from '@/components/management/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../_lib/guard'
import { hebrewMoment } from '../team/_lib/labels'
import {
  CHANNEL_LABEL,
  KIND_EVIDENCE,
  KIND_LABEL,
  NOT_A_THIRD_PARTY,
  SERVICE_LABEL,
  labelOr,
} from './_lib/labels'
import {
  allRecords,
  loadIntegrations,
  type IntegrationRecord,
  type IntegrationSection,
  type IntegrationsReport,
} from './_lib/queries'

export const metadata: Metadata = { title: 'חיבורים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Connected services and their state.
 *
 * ══ WHAT THIS SCREEN IS, AND WHAT IT DELIBERATELY IS NOT ═════════════════
 *
 * ESTIA has no integrations table. There is no stored connection, no
 * credential, no health check and no last-sync timestamp anywhere in
 * `supabase/migrations` — so there is no "connected" state to display and
 * nothing on this screen to switch off. Every other management screen here
 * reads a table named after itself; this one cannot, and says so at the top
 * rather than dressing the absence up in green ticks.
 *
 * What it shows instead is real and is evidence: the mark each service leaves
 * on the rows it writes. `payments.provider` says who charged the card,
 * `invoices.provider` says who filed the document, and `bookings.source` says
 * which channel sold the stay. Volume and recency come from counting those
 * rows. "Cardcom has taken fifty-three payments, the last on Tuesday" is a
 * sentence this database supports. "Cardcom is connected" is not.
 *
 * GATING. `requireGrant('integration.manage')` refuses the route — the grant
 * `SENSITIVE_ACTIONS` marks, because changing what the business is wired to is
 * a change of blast radius rather than of a record. Each of the three reads is
 * then guarded again by the grant its own table requires, because
 * `integration.manage` says nothing about payments and `payments_select` has
 * never heard of it: a reader who holds one and not the other is told they may
 * not read payments, not that no processor was ever used.
 *
 * THE HONEST FINDING. `integration.manage` currently governs no write path in
 * this product. It gates this screen and nothing else, because there is
 * nothing yet to manage.
 */
export default async function IntegrationsPage() {
  const actor = await requireGrant('integration.manage')

  let report: IntegrationsReport = { sections: [], nothingReadable: false }
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    report = await loadIntegrations({
      db,
      actor,
      organizationId: actor.organizationId,
    })
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const records = allRecords(report)
  const thirdParty = records.filter(
    (record) => !NOT_A_THIRD_PARTY.has(record.id),
  )
  const attention = records.reduce(
    (total, record) => total + record.needsAttentionCount,
    0,
  )

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        title="חיבורים"
        lede="השירותים החיצוניים שהעסק הזה עובד מולם, לפי מה שהם עצמם השאירו בנתונים: מי סלק, מי הפיק מסמך, ומאיזה ערוץ הגיעה ההזמנה."
      />

      <Notice title="אין כאן מתגי הפעלה, וזו אמירה על המוצר" tone="strong">
        למסד הנתונים של ESTIA אין טבלת חיבורים: אין רשומת חיבור שמורה, אין
        אישורי גישה, אין בדיקת בריאות ואין חותמת סנכרון אחרון. לכן אין כאן סטטוס
        ״מחובר״ להציג ואין מה לנתק. מה שכן קיים הוא העקבות שכל שירות משאיר
        בשורות שהוא כותב, וזה מה שמוצג — נפח ותאריך אחרון, ולא הצהרה על מצב
        החיבור. ההרשאה <code dir="ltr">integration.manage</code>, שהמסך הזה חסום
        מאחוריה, אינה שולטת כרגע באף פעולת כתיבה במוצר.
      </Notice>

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : report.nothingReadable ? (
        <EmptyState
          illustration="invoice"
          title="אין לך הרשאה לקרוא את הטבלאות שמהן המסך הזה נגזר"
          body="ההרשאה לניהול חיבורים אינה מקנה קריאה של תשלומים, חשבוניות או הזמנות — הן נשלטות בהרשאות משלהן, גם במסד הנתונים. אין כאן קביעה שהעסק אינו עובד מול אף שירות; פשוט אין ממה לגזור."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure
              label="שירותים חיצוניים שנצפו"
              value={`${thirdParty.length}`}
              note="ספירה של ערכים שונים שהופיעו בשורות, לא של חיבורים מוגדרים."
            />
            <Figure
              label="ערוצים ומקורות בסך הכול"
              value={`${records.length}`}
              note="כולל מקורות שאינם צד שלישי — טלפון, קבלה וסוכן פנימי."
            />
            <Figure
              label="שורות שממתינות לאדם"
              value={`${attention}`}
              note="תשלום במצב לא ידוע או מסמך שלא נקלט אצל הספק. זה אות הבריאות היחיד שהנתונים תומכים בו."
            />
          </div>

          {report.sections.map((section) => (
            <Section key={section.kind} section={section} />
          ))}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

function Figure({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft">
      <dl>
        <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
        <dd className="font-display text-2xl font-bold tabular-nums text-foreground">
          {value}
        </dd>
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
    </div>
  )
}

function Section({ section }: { section: IntegrationSection }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          {KIND_LABEL[section.kind]}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {KIND_EVIDENCE[section.kind]}
        </p>
      </div>

      {section.state === 'unreadable' ? (
        // Not "none". A reader without the grant the table requires is told
        // which grant is missing, because "no processor was ever used" and
        // "you may not read payments" are opposite statements.
        <Notice title="לא ניתן לגזור את החלק הזה">
          חסרה לך ההרשאה <code dir="ltr">{section.missing}</code>, ולכן השאילתה
          לא נשלחה כלל — היא הייתה חוזרת ריקה ממדיניות ההרשאות של הטבלה, ורשימה
          ריקה כאן הייתה נקראת כאילו העסק אינו עובד מול אף שירות.
        </Notice>
      ) : section.records.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-4 text-sm text-muted-foreground shadow-soft">
          אף שורה בארגון אינה נושאת ערך בעמודה הזאת. זו תשובה אמיתית: לא נעשה
          כאן שימוש בשירות מהסוג הזה.
        </p>
      ) : (
        <DataTable
          caption={`${KIND_LABEL[section.kind]} — לפי מה שנרשם בשורות`}
          columns={['שירות', 'סוג', 'שורות', 'פעילות אחרונה', 'ממתין לאדם']}
        >
          {section.records.map((record) => (
            <ServiceRow key={`${record.kind}:${record.id}`} record={record} />
          ))}
        </DataTable>
      )}
    </section>
  )
}

function ServiceRow({ record }: { record: IntegrationRecord }) {
  const internal = NOT_A_THIRD_PARTY.has(record.id)
  const name =
    record.kind === 'booking_channel'
      ? labelOr(CHANNEL_LABEL, record.id)
      : labelOr(SERVICE_LABEL, record.id)

  return (
    <Row>
      <RowHeader>
        <span className="block">{name}</span>
        <span
          dir="ltr"
          className="block font-mono text-xs font-normal text-muted-foreground"
        >
          {record.id}
        </span>
      </RowHeader>

      <Cell>
        {/* An internal source is a person at a desk or a member of this
            organization. Counting it as a connected service would report a
            business that takes every booking by telephone as integrated. */}
        <Badge tone={internal ? 'neutral' : 'brand'}>
          {internal ? 'מקור פנימי' : 'צד שלישי'}
        </Badge>
      </Cell>

      <Cell className="tabular-nums">{record.rowCount}</Cell>

      <Cell className="text-muted-foreground">
        {hebrewMoment(record.lastSeenAt) ?? 'לא נרשם תאריך'}
      </Cell>

      <Cell className="tabular-nums">
        {record.needsAttentionCount === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Badge tone="accent">{record.needsAttentionCount}</Badge>
        )}
      </Cell>
    </Row>
  )
}
