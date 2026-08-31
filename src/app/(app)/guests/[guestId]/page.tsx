import type { Metadata } from 'next'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { GuestStays } from '@/components/guests/guest-stays'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { holdsGrant } from '@/lib/authz/can'
import { formatDayMonthYear } from '@/lib/booking/dates'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  guestPaymentTotals,
  loadGuest,
  type GuestRecord,
} from '../_lib/queries'

export const metadata: Metadata = { title: 'אורח' }

const WITHHELD = 'לא זמין לצפייה בהרשאות שלך'
const NONE_RECORDED = 'לא נרשם'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One guest.
 *
 * WHAT IS REAL HERE. One row from `public.guests`, its stays from
 * `public.bookings`, and — only for a reader holding `payment.view` — what was
 * captured against those stays from `public.payments`. Two money figures are
 * shown and they are deliberately different questions: what the stays were
 * worth (`sum(bookings.total_agorot)`) and what actually arrived
 * (`sum(payments.captured_agorot)`). A CRM that prints one labelled as the
 * other is a CRM somebody chases a paid guest with.
 *
 * THREE GRANTS FOR THREE FIELDS. The name, the telephone and the e-mail are
 * `guest.view_name`, `guest.view_phone` and `guest.view_email`, and this page
 * asks all three separately because `redact()` answers them separately. A role
 * holding the phone and not the e-mail sees the phone here — it is not
 * approximated by hiding the whole contact card.
 *
 * The identity document is a fourth circle again, behind
 * `guest.view_document_id`. None of the presets in `roles.ts` grants it, so on
 * the shipped role set that card is never rendered for anybody. That is the
 * schema's intent ("almost no role needs to see this") rather than dead code,
 * and the card exists so that a business which composes such a role gets a
 * screen rather than a gap.
 *
 * WHY A MISSING GUEST IS A 404 AND NOT A REFUSAL. `guests_select` is scoped to
 * `my_organizations()`, and `loadGuest` additionally returns `null` for a
 * guest this reader's scope does not reach. A guest in another tenant, a guest
 * outside this membership's properties and a guest that does not exist are
 * therefore indistinguishable — and that is the intended answer. Saying "you
 * may not see this guest" to somebody probing ids would confirm the guest
 * exists, which is the leak.
 */
export default async function GuestDetailPage({
  params,
}: {
  params: Promise<{ guestId: string }>
}) {
  const [actor, context, { guestId }] = await Promise.all([
    requireGrant('guest.view'),
    shellContext(),
    params,
  ])

  if (!context || context.status !== 'ready') return null

  let record: GuestRecord | null = null
  let captured: Awaited<ReturnType<typeof guestPaymentTotals>> = null

  // A failure here returns early rather than being held and rendered below, as
  // the list screens do. The difference is deliberate: a list that fails has a
  // page around it worth keeping, and this page *is* the record — rendering
  // its headings above an error would frame a failed read as a guest with no
  // details.
  try {
    const db = await createClient()
    record = await loadGuest({
      db,
      actor,
      organizationId: actor.organizationId,
      guestId,
    })

    if (record) {
      captured = await guestPaymentTotals(
        db,
        actor,
        actor.organizationId,
        record.stays.map((stay) => stay.bookingId),
      )
    }
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <Shell>
        <ActionError error={safe.error} />
      </Shell>
    )
  }

  if (!record) notFound()

  const { guest, stays, summary } = record

  // The shell already resolved the names of every property in scope, so the
  // stay table is labelled without a second query. An id is never printed in
  // a name's place — see `PropertyOption` in `context.ts`.
  const propertyNames = new Map(
    context.properties.map((property) => [property.id, property.name]),
  )

  const maySeeDocument = holdsGrant(actor, 'guest.view_document_id')

  return (
    <Shell>
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/guests"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת האורחים
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {'fullName' in guest ? (
              guest.fullName
            ) : (
              <span className="text-muted-foreground">
                שם האורח אינו זמין בהרשאות שלך
              </span>
            )}
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {guest.city && <span>{guest.city}</span>}
            {guest.tags.map((tag) => (
              <Badge key={tag} tone="brand">
                {tag}
              </Badge>
            ))}
            {guest.isBlocked && <Badge tone="accent">חסום</Badge>}
          </p>
        </div>
      </header>

      {/* A blocked guest is the first thing a person at a desk needs to know,
          so it is stated above the fold and carries the reason —
          `guests_blocked_reason` makes "blocked with no reason" storable, and
          a block nobody can explain is a block nobody will honour. */}
      {guest.isBlocked && (
        <div
          role="status"
          className="rounded-xl border border-warning bg-surface px-4 py-3 text-sm text-warning"
        >
          <p className="font-semibold">האורח חסום להזמנות.</p>
          <p className="mt-1">
            {guest.blockedReason ?? 'לא נרשמה סיבה לחסימה.'}
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------------- contact */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">פרטי קשר</CardTitle>
            <CardDescription>
              שם, טלפון ואימייל הן שלוש הרשאות נפרדות. מה שחסר כאן חסר בגלל
              ההרשאה, ולא בגלל שלא נרשם — השורה אומרת מה משתי האפשרויות.
            </CardDescription>
          </CardHeader>

          <dl className="mt-5 flex flex-col gap-3 text-sm">
            <Row label="שם מלא">
              <Guarded present={'fullName' in guest} value={guest.fullName} />
            </Row>
            <Row label="טלפון">
              <Guarded
                present={'phone' in guest}
                value={guest.phone ?? null}
                ltr
              />
            </Row>
            <Row label="טלפון נוסף">
              <Guarded
                present={'phoneAlt' in guest}
                value={guest.phoneAlt ?? null}
                ltr
              />
            </Row>
            <Row label="אימייל">
              <Guarded
                present={'email' in guest}
                value={guest.email ?? null}
                ltr
              />
            </Row>
            <Row label="שפה">{languageName(guest.language)}</Row>
            <Row label="אזרחות">
              {guest.nationality
                ? countryName(guest.nationality)
                : NONE_RECORDED}
            </Row>
            <Row label="כתובת">{address(guest) ?? NONE_RECORDED}</Row>
          </dl>
        </Card>

        {/* --------------------------------------------------------- stays */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">היסטוריה</CardTitle>
            <CardDescription>
              שהיות שהתקיימו נספרות; ביטולים ואי-הגעות מוצגים בטבלה למטה ואינם
              נספרים כאן.
            </CardDescription>
          </CardHeader>

          <dl className="mt-5 flex flex-col gap-3 text-sm">
            <Row label="שהיות שהתקיימו">
              {summary.stayCount === 1
                ? 'שהות אחת'
                : `${summary.stayCount} שהיות`}
            </Row>
            <Row label="שהות אחרונה">
              {summary.lastStayOn
                ? formatDayMonthYear(summary.lastStayOn)
                : 'עוד לא שהה'}
            </Row>
            <Row label="הגעה הבאה">
              {summary.nextArrivalOn
                ? formatDayMonthYear(summary.nextArrivalOn)
                : 'אין הזמנה עתידית'}
            </Row>
            <Row label="שווי השהיות">
              {record.staysValueAgorot === undefined
                ? WITHHELD
                : formatAgorot(record.staysValueAgorot)}
            </Row>
            <Row label="נגבה בפועל">
              {captured === null
                ? WITHHELD
                : formatAgorot(captured.capturedAgorot)}
            </Row>
            {captured !== null && captured.refundedAgorot > 0 && (
              <Row label="הוחזר">{formatAgorot(captured.refundedAgorot)}</Row>
            )}
          </dl>
        </Card>

        {/* ------------------------------------------------------- consent */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">הסכמת דיוור</CardTitle>
            <CardDescription>
              הסכמה בלי תאריך היא טענה שאי אפשר להגן עליה. לכן מוצגים שניהם, או
              אף אחד.
            </CardDescription>
          </CardHeader>

          <dl className="mt-5 flex flex-col gap-3 text-sm">
            <Row label="מצב">
              {guest.marketingConsent ? (
                <Badge tone="brand">אישר דיוור</Badge>
              ) : (
                <Badge>לא אישר דיוור</Badge>
              )}
            </Row>
            <Row label="ניתנה בתאריך">
              {guest.marketingConsentAt
                ? formatDayMonthYear(guest.marketingConsentAt.slice(0, 10))
                : '—'}
            </Row>
          </dl>

          {guest.marketingConsent && guest.marketingConsentAt === null && (
            <p className="mt-4 rounded-lg border border-warning bg-surface px-3 py-2 text-xs text-warning">
              הכרטיס מסומן כמאשר דיוור אך אין תאריך הסכמה. אל תסתמך על ההסכמה
              הזו מול רגולטור עד שהמקור שלה יתועד.
            </p>
          )}
        </Card>

        {/* --------------------------------------------------------- notes */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">הערות</CardTitle>
            <CardDescription>
              ההערות גלויות לכל מי שרשאי לראות את כרטיס האורח. אין להן הרשאה
              נפרדת, בניגוד להערות הפנימיות של הזמנה.
            </CardDescription>
          </CardHeader>

          <div className="mt-5 text-sm">
            {guest.notes ? (
              <p className="whitespace-pre-line text-foreground">
                {guest.notes}
              </p>
            ) : (
              <p className="text-muted-foreground">לא נכתבו הערות על האורח.</p>
            )}
          </div>
        </Card>

        {/* ------------------------------------------------------ document */}
        {maySeeDocument && (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle as="h2">מסמך מזהה</CardTitle>
              <CardDescription>
                הרשאה נפרדת משם ומפרטי קשר, ולפי הסכימה כמעט אף תפקיד אינו זקוק
                לה.
              </CardDescription>
            </CardHeader>

            <dl className="mt-5 flex flex-col gap-3 text-sm">
              <Row label="סוג">
                {documentTypeLabel(guest.documentType ?? null)}
              </Row>
              <Row label="מספר">
                <span dir="ltr" className="font-mono">
                  {guest.documentNumber ?? NONE_RECORDED}
                </span>
              </Row>
              <Row label="מדינה מנפיקה">
                {guest.documentCountry
                  ? countryName(guest.documentCountry)
                  : NONE_RECORDED}
              </Row>
            </dl>
          </Card>
        )}

        {/* ---------------------------------------------------------- list */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle as="h2">שהיות</CardTitle>
            <CardDescription>
              כל ההזמנות של האורח שאתה רשאי לראות, מהמאוחרת למוקדמת.
            </CardDescription>
          </CardHeader>

          <div className="mt-5">
            <GuestStays stays={stays} propertyNames={propertyNames} />
          </div>
        </Card>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------ fragments -- */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {children}
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  )
}

/**
 * A field that may be withheld, may be empty, or may have a value.
 *
 * Three outcomes and three sentences. `present` is `'field' in guest` — the
 * key's absence is what `redact` produces, and collapsing it into "empty"
 * would tell a reader that nobody recorded a telephone number when in truth
 * they are simply not allowed to have it.
 */
function Guarded({
  present,
  value,
  ltr = false,
}: {
  present: boolean
  value: string | null | undefined
  ltr?: boolean
}) {
  if (!present) {
    return <span className="font-normal text-muted-foreground">{WITHHELD}</span>
  }
  if (value === null || value === undefined) {
    return (
      <span className="font-normal text-muted-foreground">{NONE_RECORDED}</span>
    )
  }
  return ltr ? (
    <span dir="ltr" className="inline-block">
      {value}
    </span>
  ) : (
    <>{value}</>
  )
}

/** The address as one line, or null when nothing at all was recorded. */
function address(guest: GuestRecord['guest']): string | null {
  const parts = [
    guest.addressLine1,
    guest.city,
    guest.postalCode,
    guest.country ? countryName(guest.country) : null,
  ].filter((part): part is string => part !== null && part.length > 0)

  return parts.length > 0 ? parts.join(', ') : null
}

/** `guests_id_document_type` names exactly these four, and nothing else. */
function documentTypeLabel(type: string | null): string {
  switch (type) {
    case 'id_card':
      return 'תעודת זהות'
    case 'passport':
      return 'דרכון'
    case 'driver_license':
      return 'רישיון נהיגה'
    case 'other':
      return 'אחר'
    default:
      return NONE_RECORDED
  }
}

/**
 * A language code, named in Hebrew.
 *
 * `guests.language` has no check constraint, so the value is whatever was
 * written. `Intl.DisplayNames` names real codes and hands back anything else
 * unchanged, which is the honest fallback: printing `xx` beats inventing a
 * language for it.
 */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['he'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The same, for the ISO-3166 alpha-2 columns. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['he'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}
