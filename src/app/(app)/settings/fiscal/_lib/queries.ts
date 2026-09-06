/**
 * EXECUTION CONTEXT — SERVER ONLY. What the fiscal settings screen reads.
 *
 * Four reads and no derivation that is not the domain's own. The provider's
 * state, the documents, the ones that need a person, and the last time
 * anybody compared ESTIA's references against the vendor's list.
 *
 * ── Nothing here computes money ───────────────────────────────────────────
 *
 * `amount_agorot` is read through `asAgorot`, which refuses a float at the
 * border, and the only arithmetic in this file is `sumAgorot` — the domain's
 * own addition. A screen that re-derived a document total from a rate would be
 * a second opinion about a legal document, and the vendor's figure is the one
 * that is on the paper.
 *
 * ── The tables may not exist yet ──────────────────────────────────────────
 *
 * They are created by a migration this worker does not write. `readProvisioned`
 * turns that one specific failure into a state the page renders as a
 * `DomainGap` naming the missing tables — never as an empty list, which would
 * tell a business the capability works and has nothing in it. Every other
 * failure is rethrown untouched.
 *
 * ── Three floors ──────────────────────────────────────────────────────────
 *
 *   1. `requireGrant('invoice.view')` refuses the route.
 *   2. The membership's scope narrows the query, and each row is checked again
 *      with `can()` against the property it names.
 *   3. Row level security refuses regardless of both.
 */

import { scopeNarrowings } from '@/app/(app)/preparation/_lib/queries'
import { can, scopeFor, type Actor, type Resource } from '@/lib/authz/can'
import {
  FISCAL_DOCUMENT_STATUSES,
  FISCAL_DOCUMENT_TYPES,
  NULL_FISCAL_PROVIDER,
  type FiscalDocument,
  type FiscalDocumentStatus,
} from '@/lib/fiscal'
import { readProvisioned, type Provisioned } from '@/lib/fiscal/provisioning'
import { CURRENCY, sumAgorot } from '@/lib/finance'
import {
  asAgorot,
  asBoolean,
  asDate,
  asDateOrNull,
  asEnum,
  asIsoDateOrNull,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/** The storage this screen needs, named as a migration would create it. */
export const FISCAL_TABLES = [
  'fiscal_settings',
  'fiscal_documents',
  'fiscal_reconciliation_runs',
] as const

/** The ceiling on any one panel. A queue nobody can read is not a queue. */
export const FISCAL_PAGE_SIZE = 50

/* ------------------------------------------------------------- settings -- */

export type FiscalProviderState = {
  /** `none` until somebody connects a vendor. Not an error state. */
  provider: string
  /** Whether this organization expects an accounting document at all. */
  documentsExpected: boolean
  /** What the connected provider declares it can do. Empty for `none`. */
  capabilities: readonly string[]
  connectedAt: Date | null
}

/** What an organization that has never saved a row has. */
export function defaultProviderState(): FiscalProviderState {
  return {
    provider: NULL_FISCAL_PROVIDER,
    documentsExpected: false,
    capabilities: [],
    connectedAt: null,
  }
}

/* ------------------------------------------------------------ documents -- */

export type FiscalDocumentRow = {
  document: FiscalDocument
  /** The booking's human reference, for a person scanning the list. */
  bookingReference: string | null
}

export type FiscalCounts = Record<FiscalDocumentStatus, number>

export type FiscalScreenView = {
  provider: FiscalProviderState
  counts: FiscalCounts
  /** Everything, newest first, to the page ceiling. */
  documents: readonly FiscalDocumentRow[]
  /** The §148 queue: documents a person has to do something about. */
  needsPerson: readonly FiscalDocumentRow[]
  /** Money whose paperwork is outstanding. A sum, never a percentage. */
  pendingAgorot: number
  lastRun: ReconciliationRunRow | null
}

export type ReconciliationRunRow = {
  id: string
  provider: string
  from: string
  to: string
  ranAt: Date
  /** `null` when the provider refused and no comparison happened. */
  differenceCount: number | null
  differenceAgorot: number | null
  /** Hebrew, from the provider. Present exactly when nothing was compared. */
  refusalReason: string | null
}

/* --------------------------------------------------------------- shared -- */

function resourceFor(
  organizationId: string,
  propertyId: string | null,
): Resource {
  const resource: Resource = { organizationId, family: 'finance' }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

function narrowings(actor: Actor): ReturnType<typeof scopeNarrowings> {
  return scopeNarrowings(
    actor,
    scopeFor(actor, {
      organizationId: actor.organizationId,
      family: 'finance',
    }),
  )
}

const DOCUMENT_COLUMNS =
  'id, organization_id, property_id, booking_id, invoice_id, provider, ' +
  'provider_document_id, provider_document_number, type, status, ' +
  'customer_name, customer_tax_id, amount_agorot, tax_agorot, tax_rate_bps, ' +
  'issue_date, source_kind, source_id, document_url, document_url_expires_at, ' +
  'failure_code, failure_reason, provider_status, attempt_count, ' +
  'last_attempt_at, next_retry_at, reviewed_at, reviewed_by, ' +
  'corrects_document_id, created_at, updated_at, version, ' +
  'bookings(reference)'

/**
 * A row to a `FiscalDocument`.
 *
 * `failure` is assembled from three columns and is `null` when there is no
 * failure code — which is exactly the shape the domain expects. The three
 * columns are not folded into one jsonb because `failure_code` is what the
 * retry queue filters on and a jsonb key is a worse index than a column.
 */
function toDocument(row: Row): FiscalDocument {
  const failureCode = asStringOrNull(row, 'failure_code')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    invoiceId: asStringOrNull(row, 'invoice_id'),
    provider: asString(row, 'provider'),
    providerDocumentId: asStringOrNull(row, 'provider_document_id'),
    providerDocumentNumber: asStringOrNull(row, 'provider_document_number'),
    type: asEnum(row, 'type', FISCAL_DOCUMENT_TYPES),
    status: asEnum(row, 'status', FISCAL_DOCUMENT_STATUSES),
    customerName: asString(row, 'customer_name'),
    customerTaxId: asStringOrNull(row, 'customer_tax_id'),
    amountAgorot: asAgorot(row, 'amount_agorot'),
    taxAgorot: asAgorot(row, 'tax_agorot'),
    taxRateBps: asNumberOrNull(row, 'tax_rate_bps'),
    currency: CURRENCY,
    issueDate: asIsoDateOrNull(row, 'issue_date'),
    source: {
      kind: asEnum(row, 'source_kind', [
        'invoice',
        'payment',
        'refund',
        'credit_note',
      ] as const),
      id: asString(row, 'source_id'),
    },
    documentUrl: asStringOrNull(row, 'document_url'),
    documentUrlExpiresAt: asDateOrNull(row, 'document_url_expires_at'),
    failure:
      failureCode === null
        ? null
        : {
            code: failureCode,
            reason: asStringOrNull(row, 'failure_reason') ?? '',
            providerStatus: asStringOrNull(row, 'provider_status'),
          },
    attemptCount: asNumber(row, 'attempt_count'),
    lastAttemptAt: asDateOrNull(row, 'last_attempt_at'),
    nextRetryAt: asDateOrNull(row, 'next_retry_at'),
    reviewedAt: asDateOrNull(row, 'reviewed_at'),
    reviewedByUserId: asStringOrNull(row, 'reviewed_by'),
    correctsDocumentId: asStringOrNull(row, 'corrects_document_id'),
    createdAt: asDate(row, 'created_at'),
    updatedAt: asDate(row, 'updated_at'),
    version: asNumber(row, 'version'),
  }
}

function embeddedReference(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const record = Array.isArray(value) ? value[0] : value
  if (record === null || typeof record !== 'object') return null
  const reference = (record as Record<string, unknown>).reference
  return typeof reference === 'string' ? reference : null
}

function emptyCounts(): FiscalCounts {
  const counts = {} as FiscalCounts
  for (const status of FISCAL_DOCUMENT_STATUSES) counts[status] = 0
  return counts
}

/* ----------------------------------------------------------------- read -- */

async function loadProviderState(
  db: Db,
  organizationId: string,
): Promise<FiscalProviderState> {
  const { data, error } = await db
    .from('fiscal_settings')
    .select('provider, documents_expected, capabilities, connected_at')
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw error
  if (data === null) return defaultProviderState()

  const row = toRow(data)
  return {
    provider: asStringOrNull(row, 'provider') ?? NULL_FISCAL_PROVIDER,
    documentsExpected: asBoolean(row, 'documents_expected'),
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    connectedAt: asDateOrNull(row, 'connected_at'),
  }
}

async function loadDocuments(
  db: Db,
  actor: Actor,
  organizationId: string,
): Promise<readonly FiscalDocumentRow[]> {
  const results = await Promise.all(
    narrowings(actor).map(async (narrowing) => {
      let query = db
        .from('fiscal_documents')
        .select(DOCUMENT_COLUMNS)
        .eq('organization_id', organizationId)

      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(FISCAL_PAGE_SIZE)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  return [...merged.values()]
    .filter((row) =>
      can(
        actor,
        'invoice.view',
        resourceFor(organizationId, asStringOrNull(row, 'property_id')),
      ),
    )
    .map((row) => ({
      document: toDocument(row),
      bookingReference: embeddedReference(row.bookings),
    }))
    .sort(
      (a, b) => b.document.createdAt.getTime() - a.document.createdAt.getTime(),
    )
    .slice(0, FISCAL_PAGE_SIZE)
}

async function loadLastRun(
  db: Db,
  organizationId: string,
): Promise<ReconciliationRunRow | null> {
  const { data, error } = await db
    .from('fiscal_reconciliation_runs')
    .select(
      'id, provider, window_from, window_to, ran_at, difference_count, ' +
        'difference_agorot, refusal_reason',
    )
    .eq('organization_id', organizationId)
    .order('ran_at', { ascending: false })
    .limit(1)

  if (error) throw error
  const [row] = toRows(data)
  if (row === undefined) return null

  return {
    id: asString(row, 'id'),
    provider: asString(row, 'provider'),
    from: asString(row, 'window_from'),
    to: asString(row, 'window_to'),
    ranAt: asDate(row, 'ran_at'),
    differenceCount: asNumberOrNull(row, 'difference_count'),
    differenceAgorot: asNumberOrNull(row, 'difference_agorot'),
    refusalReason: asStringOrNull(row, 'refusal_reason'),
  }
}

/**
 * Everything the screen shows, or the statement that the storage is absent.
 *
 * The counts are computed from the rows already read rather than from three
 * `count` queries: the page ceiling is fifty, and three extra round trips to
 * count what is already in memory is three round trips.
 *
 * Takes the client rather than constructing one, the way
 * `finance/_lib/queries.ts` does. A read that builds its own Supabase client
 * cannot be driven by the fake or by the demo dataset, and an untestable read
 * is where a wrong column name lives until production.
 */
export async function loadFiscalScreen(
  db: Db,
  actor: Actor,
  organizationId: string,
): Promise<Provisioned<FiscalScreenView>> {
  return readProvisioned(FISCAL_TABLES, async () => {
    const [provider, documents, lastRun] = await Promise.all([
      loadProviderState(db, organizationId),
      loadDocuments(db, actor, organizationId),
      loadLastRun(db, organizationId),
    ])

    const counts = emptyCounts()
    for (const row of documents) counts[row.document.status] += 1

    const needsPerson = documents.filter((row) =>
      NEEDS_PERSON.includes(row.document.status),
    )

    return {
      provider,
      counts,
      documents,
      needsPerson,
      pendingAgorot: sumAgorot(
        needsPerson.map((row) => row.document.amountAgorot),
      ),
      lastRun,
    }
  })
}

/**
 * The statuses that put a row in front of a person.
 *
 * `failed` is here whether or not a retry is scheduled, because this is a
 * settings screen rather than the queue itself: somebody looking at it wants
 * to see everything that is not done. `describeSettlement` makes the finer
 * distinction — retrying versus needing review — where it matters, beside a
 * payment.
 */
const NEEDS_PERSON: readonly FiscalDocumentStatus[] = [
  'failed',
  'refused',
  'unknown',
]

/*
 * There is deliberately no `settlementFor` helper here.
 *
 * `describeSettlement` in `@/lib/fiscal` is the one entry point to the §148
 * pair, and the payment-facing screens should call it directly. A convenience
 * wrapper in a settings route's `_lib` would be a second place the question
 * "is the paperwork done" is answered, and the two would eventually disagree —
 * which is the exact failure `failure.ts` is written to make impossible.
 */
