/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading and writing what the business asks
 * of a guest.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * Migration 0034 created `guest_journey_settings` and `guest_journey_content`
 * and, until this file, no screen anywhere wrote either of them. Everything
 * the guest portal does — whether confirmation is required, whether there is a
 * contract, which details are asked for, when the address is released, what
 * the guide says, how a guest leaves, whether a review is requested — was
 * configurable in principle and reachable only with SQL in practice. A
 * capability that only its author can use is not a capability.
 *
 * ── Every write goes through `defineOperation` ────────────────────────────
 *
 * Authorization → validation → domain rule → transaction → audit event →
 * idempotency, in that order, with no way to reach the write without them.
 * That matters here specifically because one of these fields is a security
 * control: `arrival_release` decides when a door code becomes visible, and a
 * change to it with no row in `audit_events` is a change to who can get into a
 * house that nobody can trace.
 *
 * ── This module decides nothing about money ───────────────────────────────
 *
 * `src/lib/payments` owns what a guest must pay and `resolveCollectionPolicy`
 * is the one implementation of it. There is no policy field here, no deposit
 * amount, and no `switch` on a payment policy. The settings screen's payment
 * section reads that module and links to `/settings/payments`, which is the
 * one screen that writes it.
 *
 * ── And it decides nothing about disclosure either ────────────────────────
 *
 * `guest_arrival_released` in 0034 is the function that answers "may this
 * guest see the door code", and it is deliberately the only one. What this
 * module writes is that function's *inputs* — the release mode and the hours.
 * Nothing here reads a code, gates a code, or returns one.
 */

import { assertCan, type Resource } from '../authz/can'
import { BusinessRuleError, ConflictError } from '../errors'
import {
  PG_ERROR,
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import {
  defineOperation,
  s,
  type Operation,
  type TransactionHandle,
} from '../service'

import {
  DURING_STAY_TOPICS,
  JOURNEY_PRESET_IDS,
  SHIPPED_JOURNEY_SETTINGS,
  describeChanges,
  presetById,
  resolvePreset,
  type JourneyChange,
  type JourneyPresetId,
} from './presets'
import {
  GUEST_ARRIVAL_RELEASES,
  GUEST_CONTRACT_MODES,
  GUEST_DETAIL_FIELDS,
  GUEST_REQUEST_CATEGORIES,
  RECONFIRMATION_TRIGGERS,
  type GuestArrivalRelease,
  type GuestContractMode,
  type GuestDetailField,
  type GuestJourneySettings,
  type GuestRequestCategory,
  type ReconfirmationTrigger,
} from './types'

/* ----------------------------------------------------------- the records -- */

/**
 * One saved row.
 *
 * `propertyId: null` is the organization-wide default and is not a missing
 * value — 0034 says so in a column comment and resolves the pair with a
 * property row winning wholesale. Nothing here merges the two field by field,
 * because a half-inherited policy is one nobody can predict from the screen.
 */
export type JourneySettingsRecord = GuestJourneySettings & {
  id: string
  organizationId: string
  propertyId: string | null
  version: number
  updatedAt: string | null
}

/**
 * The same record, under the name the settings screen calls it.
 *
 * A type alias and never a second shape. Note that this module is SERVER ONLY
 * — it reaches `src/lib/persistence` and the Postgres driver behind it — so a
 * Client Component may import this *type* (types are erased) and must take
 * every value, label and pure function from `./presets`, which is the leaf.
 */
export type SavedGuestJourneySettings = JourneySettingsRecord

/** The words a guest eventually reads. Per property, because it is a house. */
export type JourneyContent = {
  id: string
  organizationId: string
  propertyId: string
  addressNote: string | null
  directions: string | null
  mapUrl: string | null
  accessInstructions: string | null
  accessCode: string | null
  parking: string | null
  wifiNetwork: string | null
  wifiPassword: string | null
  propertyGuide: string | null
  emergencyContact: string | null
  checkoutInstructions: string | null
  version: number
  updatedAt: string | null
}

export type JourneySettingsDraft = GuestJourneySettings & {
  propertyId: string | null
}

export type JourneyContentDraft = Omit<
  JourneyContent,
  'id' | 'organizationId' | 'version' | 'updatedAt'
>

/**
 * The settings in force for a scope, and whether anybody chose them.
 *
 * `source` exists so the screen can say "these are the shipped defaults" out
 * loud rather than presenting them as somebody's decision. A business reading
 * its own configuration must be able to tell the difference between a value it
 * set and a value it inherited.
 */
export type EffectiveJourneySettings = {
  settings: GuestJourneySettings
  source: 'property' | 'organization' | 'shipped'
  /** The row these came from. Null when they are the shipped defaults. */
  record: JourneySettingsRecord | null
}

/* ------------------------------------------------------------ the port -- */

export interface JourneySettingsRepository {
  loadSettings(
    organizationId: string,
    propertyId: string | null,
  ): Promise<JourneySettingsRecord | null>
  listSettings(
    organizationId: string,
  ): Promise<readonly JourneySettingsRecord[]>
  saveSettings(
    organizationId: string,
    draft: JourneySettingsDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<JourneySettingsRecord>
  /** Remove a property override so the organization default applies again. */
  clearSettings(
    organizationId: string,
    propertyId: string,
    tx?: TransactionHandle,
  ): Promise<void>

  loadContent(
    organizationId: string,
    propertyId: string,
  ): Promise<JourneyContent | null>
  saveContent(
    organizationId: string,
    draft: JourneyContentDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<JourneyContent>
}

/**
 * Property row, else organization default, else the shipped defaults.
 *
 * The same precedence as `guest_journey_effective_settings` in 0034, resolved
 * here so the settings screen shows what a guest of that property is actually
 * getting rather than what happens to be stored under the scope on screen.
 */
export function effectiveSettings(
  rows: readonly JourneySettingsRecord[],
  propertyId: string | null,
): EffectiveJourneySettings {
  const property =
    propertyId === null
      ? null
      : (rows.find((row) => row.propertyId === propertyId) ?? null)

  if (property) {
    return {
      settings: stripRecord(property),
      source: 'property',
      record: property,
    }
  }

  const organization = rows.find((row) => row.propertyId === null) ?? null
  if (organization) {
    return {
      settings: stripRecord(organization),
      source: 'organization',
      record: organization,
    }
  }

  return { settings: SHIPPED_JOURNEY_SETTINGS, source: 'shipped', record: null }
}

/** The settings half of a record, without the row's own bookkeeping. */
export function stripRecord(
  record: JourneySettingsRecord,
): GuestJourneySettings {
  return {
    contractMode: record.contractMode,
    requireGuestConfirmation: record.requireGuestConfirmation,
    requiredDetailFields: [...record.requiredDetailFields],
    optionalDetailFields: [...record.optionalDetailFields],
    arrivalRelease: record.arrivalRelease,
    arrivalReleaseHours: record.arrivalReleaseHours,
    duringStayTopics: [...record.duringStayTopics],
    requestsEnabled: record.requestsEnabled,
    requestCategories: [...record.requestCategories],
    checkoutDeclarationEnabled: record.checkoutDeclarationEnabled,
    reviewEnabled: record.reviewEnabled,
    reviewUrl: record.reviewUrl,
    rebookEnabled: record.rebookEnabled,
    reconfirmationTriggers: [...record.reconfirmationTriggers],
  }
}

/* ------------------------------------------------------------- mapping -- */

const SETTINGS_COLUMNS =
  'id, organization_id, property_id, contract_mode, require_guest_confirmation, ' +
  'required_detail_fields, optional_detail_fields, arrival_release, ' +
  'arrival_release_hours, during_stay_topics, requests_enabled, ' +
  'request_categories, checkout_declaration_enabled, review_enabled, ' +
  'review_url, rebook_enabled, reconfirmation_triggers, version, updated_at'

const CONTENT_COLUMNS =
  'id, organization_id, property_id, address_note, directions, map_url, ' +
  'access_instructions, access_code, parking, wifi_network, wifi_password, ' +
  'property_guide, emergency_contact, checkout_instructions, version, updated_at'

/**
 * A member the database knows and this build does not.
 *
 * Dropped rather than carried through as a string. The alternative is a screen
 * rendering `undefined` for a label it cannot look up, and the vocabularies
 * here mirror Postgres enums that only a migration can widen — so an unknown
 * member means this deployment is behind the database, not that the row is
 * corrupt.
 */
function membersOf<T extends string>(
  values: readonly string[],
  vocabulary: readonly T[],
): T[] {
  const known = new Set<string>(vocabulary)
  return values.filter((value): value is T => known.has(value))
}

export function settingsFromRow(row: Row): JourneySettingsRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    contractMode: (asStringOrNull(row, 'contract_mode') ??
      'disabled') as GuestContractMode,
    requireGuestConfirmation: asBoolean(row, 'require_guest_confirmation'),
    requiredDetailFields: membersOf<GuestDetailField>(
      asStringArray(row, 'required_detail_fields'),
      GUEST_DETAIL_FIELDS,
    ),
    optionalDetailFields: membersOf<GuestDetailField>(
      asStringArray(row, 'optional_detail_fields'),
      GUEST_DETAIL_FIELDS,
    ),
    arrivalRelease: (asStringOrNull(row, 'arrival_release') ??
      'after_confirmation') as GuestArrivalRelease,
    arrivalReleaseHours: asNumber(row, 'arrival_release_hours'),
    duringStayTopics: asStringArray(row, 'during_stay_topics'),
    requestsEnabled: asBoolean(row, 'requests_enabled'),
    requestCategories: membersOf<GuestRequestCategory>(
      asStringArray(row, 'request_categories'),
      GUEST_REQUEST_CATEGORIES,
    ),
    checkoutDeclarationEnabled: asBoolean(row, 'checkout_declaration_enabled'),
    reviewEnabled: asBoolean(row, 'review_enabled'),
    reviewUrl: asStringOrNull(row, 'review_url'),
    rebookEnabled: asBoolean(row, 'rebook_enabled'),
    reconfirmationTriggers: membersOf<ReconfirmationTrigger>(
      asStringArray(row, 'reconfirmation_triggers'),
      RECONFIRMATION_TRIGGERS,
    ),
    version: asNumber(row, 'version'),
    updatedAt: asStringOrNull(row, 'updated_at'),
  }
}

export function contentFromRow(row: Row): JourneyContent {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    addressNote: asStringOrNull(row, 'address_note'),
    directions: asStringOrNull(row, 'directions'),
    mapUrl: asStringOrNull(row, 'map_url'),
    accessInstructions: asStringOrNull(row, 'access_instructions'),
    accessCode: asStringOrNull(row, 'access_code'),
    parking: asStringOrNull(row, 'parking'),
    wifiNetwork: asStringOrNull(row, 'wifi_network'),
    wifiPassword: asStringOrNull(row, 'wifi_password'),
    propertyGuide: asStringOrNull(row, 'property_guide'),
    emergencyContact: asStringOrNull(row, 'emergency_contact'),
    checkoutInstructions: asStringOrNull(row, 'checkout_instructions'),
    version: asNumber(row, 'version'),
    updatedAt: asStringOrNull(row, 'updated_at'),
  }
}

function settingsColumns(draft: JourneySettingsDraft): Record<string, unknown> {
  return {
    contract_mode: draft.contractMode,
    require_guest_confirmation: draft.requireGuestConfirmation,
    required_detail_fields: [...draft.requiredDetailFields],
    optional_detail_fields: [...draft.optionalDetailFields],
    arrival_release: draft.arrivalRelease,
    arrival_release_hours: draft.arrivalReleaseHours,
    during_stay_topics: [...draft.duringStayTopics],
    requests_enabled: draft.requestsEnabled,
    request_categories: [...draft.requestCategories],
    checkout_declaration_enabled: draft.checkoutDeclarationEnabled,
    review_enabled: draft.reviewEnabled,
    review_url: draft.reviewUrl,
    rebook_enabled: draft.rebookEnabled,
    reconfirmation_triggers: [...draft.reconfirmationTriggers],
  }
}

function contentColumns(draft: JourneyContentDraft): Record<string, unknown> {
  return {
    address_note: draft.addressNote,
    directions: draft.directions,
    map_url: draft.mapUrl,
    access_instructions: draft.accessInstructions,
    access_code: draft.accessCode,
    parking: draft.parking,
    wifi_network: draft.wifiNetwork,
    wifi_password: draft.wifiPassword,
    property_guide: draft.propertyGuide,
    emergency_contact: draft.emergencyContact,
    checkout_instructions: draft.checkoutInstructions,
  }
}

/* ------------------------------------------------------ over PostgREST -- */

/**
 * Why this reads and then writes instead of upserting.
 *
 * `guest_journey_settings` is keyed by two **partial** unique indexes — one
 * `where property_id is null`, one `where property_id is not null` — because a
 * null property id is a real key value here rather than a missing one.
 * `ON CONFLICT` can infer a partial index only when the statement repeats its
 * `WHERE` clause, and PostgREST's upsert has nowhere to put one. So the choice
 * is a read followed by an insert or an update, inside the operation's
 * transaction, with the index still standing behind it: a concurrent creation
 * raises 23505 and is reported as a conflict to reload rather than silently
 * winning.
 */
export class SupabaseJourneySettingsRepository implements JourneySettingsRepository {
  constructor(private readonly db: Db) {}

  async loadSettings(
    organizationId: string,
    propertyId: string | null,
  ): Promise<JourneySettingsRecord | null> {
    const query = this.db
      .from('guest_journey_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)

    const { data, error } = await (
      propertyId === null
        ? query.is('property_id', null)
        : query.eq('property_id', propertyId)
    ).maybeSingle()

    if (error) throw error
    return data ? settingsFromRow(toRow(data)) : null
  }

  async listSettings(
    organizationId: string,
  ): Promise<readonly JourneySettingsRecord[]> {
    const { data, error } = await this.db
      .from('guest_journey_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)

    if (error) throw error
    return toRows(data ?? []).map(settingsFromRow)
  }

  async saveSettings(
    organizationId: string,
    draft: JourneySettingsDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<JourneySettingsRecord> {
    const db = clientFor(tx, this.db)
    const existing = await this.loadSettings(organizationId, draft.propertyId)

    if (existing) {
      const { data, error } = await db
        .from('guest_journey_settings')
        .update({ ...settingsColumns(draft), updated_by: actorUserId })
        .eq('organization_id', organizationId)
        .eq('id', existing.id)
        .select(SETTINGS_COLUMNS)
        .single()

      if (error) throw error
      if (tx) recordWrite(tx, 'guest_journey_settings.update')
      return settingsFromRow(toRow(data))
    }

    const { data, error } = await db
      .from('guest_journey_settings')
      .insert({
        organization_id: organizationId,
        property_id: draft.propertyId,
        ...settingsColumns(draft),
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select(SETTINGS_COLUMNS)
      .single()

    if (isDuplicate(error)) throw journeySettingsRaceError(error)
    if (error) throw error
    if (tx) recordWrite(tx, 'guest_journey_settings.insert')
    return settingsFromRow(toRow(data))
  }

  async clearSettings(
    organizationId: string,
    propertyId: string,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)
    const { error } = await db
      .from('guest_journey_settings')
      .delete()
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)

    if (error) throw error
    if (tx) recordWrite(tx, 'guest_journey_settings.delete')
  }

  async loadContent(
    organizationId: string,
    propertyId: string,
  ): Promise<JourneyContent | null> {
    const { data, error } = await this.db
      .from('guest_journey_content')
      .select(CONTENT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (error) throw error
    return data ? contentFromRow(toRow(data)) : null
  }

  async saveContent(
    organizationId: string,
    draft: JourneyContentDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<JourneyContent> {
    const db = clientFor(tx, this.db)
    const existing = await this.loadContent(organizationId, draft.propertyId)

    if (existing) {
      const { data, error } = await db
        .from('guest_journey_content')
        .update({ ...contentColumns(draft), updated_by: actorUserId })
        .eq('organization_id', organizationId)
        .eq('id', existing.id)
        .select(CONTENT_COLUMNS)
        .single()

      if (error) throw error
      if (tx) recordWrite(tx, 'guest_journey_content.update')
      return contentFromRow(toRow(data))
    }

    const { data, error } = await db
      .from('guest_journey_content')
      .insert({
        organization_id: organizationId,
        property_id: draft.propertyId,
        ...contentColumns(draft),
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select(CONTENT_COLUMNS)
      .single()

    if (isDuplicate(error)) throw journeySettingsRaceError(error)
    if (error) throw error
    if (tx) recordWrite(tx, 'guest_journey_content.insert')
    return contentFromRow(toRow(data))
  }
}

function isDuplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_ERROR.UNIQUE_VIOLATION
  )
}

function journeySettingsRaceError(cause: unknown): ConflictError {
  return new ConflictError({
    resourceType: 'guest_journey_settings',
    userMessage:
      'ההגדרות נשמרו על ידי משתמש אחר בזמן שערכת אותן. רענן את הדף כדי לראות את המצב הנוכחי ובצע את השינוי מחדש.',
    cause,
  })
}

/* ------------------------------------------------------- for the tests -- */

/**
 * The same port, in memory.
 *
 * Not a convenience: it is what lets the operations be exercised without
 * PostgREST, so the rules below — a contract-gated address with no contract,
 * a review with no link — are proved as a table rather than as seeded rows.
 */
export class InMemoryJourneySettingsRepository implements JourneySettingsRepository {
  settings: JourneySettingsRecord[] = []
  content: JourneyContent[] = []
  private sequence = 0

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  async loadSettings(organizationId: string, propertyId: string | null) {
    return (
      this.settings.find(
        (row) =>
          row.organizationId === organizationId &&
          row.propertyId === propertyId,
      ) ?? null
    )
  }

  async listSettings(organizationId: string) {
    return this.settings.filter((row) => row.organizationId === organizationId)
  }

  async saveSettings(organizationId: string, draft: JourneySettingsDraft) {
    const existing = await this.loadSettings(organizationId, draft.propertyId)
    const record: JourneySettingsRecord = {
      ...draft,
      id: existing?.id ?? this.nextId('settings'),
      organizationId,
      propertyId: draft.propertyId,
      version: (existing?.version ?? 0) + 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
    }

    if (existing) {
      this.settings = this.settings.map((row) =>
        row.id === existing.id ? record : row,
      )
    } else {
      this.settings.push(record)
    }

    return record
  }

  async clearSettings(organizationId: string, propertyId: string) {
    this.settings = this.settings.filter(
      (row) =>
        !(
          row.organizationId === organizationId && row.propertyId === propertyId
        ),
    )
  }

  async loadContent(organizationId: string, propertyId: string) {
    return (
      this.content.find(
        (row) =>
          row.organizationId === organizationId &&
          row.propertyId === propertyId,
      ) ?? null
    )
  }

  async saveContent(organizationId: string, draft: JourneyContentDraft) {
    const existing = await this.loadContent(organizationId, draft.propertyId)
    const record: JourneyContent = {
      ...draft,
      id: existing?.id ?? this.nextId('content'),
      organizationId,
      version: (existing?.version ?? 0) + 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
    }

    if (existing) {
      this.content = this.content.map((row) =>
        row.id === existing.id ? record : row,
      )
    } else {
      this.content.push(record)
    }

    return record
  }
}

/* --------------------------------------------------------------- input -- */

const SETTINGS_INPUT = s.object({
  propertyId: s.nullable(s.uuid({ label: 'נכס' })),
  contractMode: s.enumOf(GUEST_CONTRACT_MODES, { label: 'חוזה' }),
  requireGuestConfirmation: s.boolean({ label: 'אישור האורח' }),
  requiredDetailFields: s.arrayOf(
    s.enumOf(GUEST_DETAIL_FIELDS, { label: 'שדה' }),
    { label: 'פרטים נדרשים', max: GUEST_DETAIL_FIELDS.length },
  ),
  optionalDetailFields: s.arrayOf(
    s.enumOf(GUEST_DETAIL_FIELDS, { label: 'שדה' }),
    { label: 'פרטים לא חובה', max: GUEST_DETAIL_FIELDS.length },
  ),
  arrivalRelease: s.enumOf(GUEST_ARRIVAL_RELEASES, {
    label: 'מתי נחשפים פרטי ההגעה',
  }),
  // `guest_journey_settings_hours_sane`, copied rather than invented.
  arrivalReleaseHours: s.number({
    label: 'שעות לפני ההגעה',
    integer: true,
    min: 0,
    max: 720,
  }),
  duringStayTopics: s.arrayOf(s.enumOf(DURING_STAY_TOPICS, { label: 'נושא' }), {
    label: 'מה מוצג במהלך השהות',
    max: DURING_STAY_TOPICS.length,
  }),
  requestsEnabled: s.boolean({ label: 'בקשות מהאורח' }),
  requestCategories: s.arrayOf(
    s.enumOf(GUEST_REQUEST_CATEGORIES, { label: 'סוג בקשה' }),
    { label: 'סוגי בקשות', max: GUEST_REQUEST_CATEGORIES.length },
  ),
  checkoutDeclarationEnabled: s.boolean({ label: 'הצהרת יציאה' }),
  reviewEnabled: s.boolean({ label: 'בקשת ביקורת' }),
  reviewUrl: s.nullable(s.string({ label: 'קישור לביקורת', max: 2000 })),
  rebookEnabled: s.boolean({ label: 'הזמנה חוזרת' }),
  reconfirmationTriggers: s.arrayOf(
    s.enumOf(RECONFIRMATION_TRIGGERS, { label: 'שינוי' }),
    { label: 'שינויים המבטלים אישור', max: RECONFIRMATION_TRIGGERS.length },
  ),
})

const CONTENT_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  addressNote: s.nullable(s.string({ label: 'הערת כתובת', max: 2000 })),
  directions: s.nullable(s.string({ label: 'הוראות הגעה', max: 4000 })),
  mapUrl: s.nullable(s.string({ label: 'קישור למפה', max: 2000 })),
  accessInstructions: s.nullable(
    s.string({ label: 'הוראות כניסה', max: 4000 }),
  ),
  accessCode: s.nullable(s.string({ label: 'קוד כניסה', max: 120 })),
  parking: s.nullable(s.string({ label: 'חניה', max: 2000 })),
  wifiNetwork: s.nullable(s.string({ label: 'שם הרשת', max: 200 })),
  wifiPassword: s.nullable(s.string({ label: 'סיסמת הרשת', max: 200 })),
  propertyGuide: s.nullable(s.string({ label: 'מדריך הנכס', max: 8000 })),
  emergencyContact: s.nullable(s.string({ label: 'איש קשר לחירום', max: 500 })),
  checkoutInstructions: s.nullable(
    s.string({ label: 'הוראות יציאה', max: 4000 }),
  ),
})

const PRESET_INPUT = s.object({
  propertyId: s.nullable(s.uuid({ label: 'נכס' })),
  presetId: s.enumOf(JOURNEY_PRESET_IDS, { label: 'תבנית' }),
})

export type JourneySettingsInput = {
  propertyId: string | null
} & GuestJourneySettings

export type JourneyContentInput = JourneyContentDraft

export type ApplyPresetInput = {
  propertyId: string | null
  presetId: JourneyPresetId
}

export type ApplyPresetResult = {
  settings: JourneySettingsRecord
  changes: readonly JourneyChange[]
  notes: readonly string[]
}

/* ------------------------------------------------------------- refusals -- */

/**
 * An address that will never be released.
 *
 * `after_contract` with no contract configured is not a preference, it is a
 * lock with no key: `guest_arrival_released` returns false on that branch
 * forever, so every guest of this business would reach their arrival day with
 * no address and telephone somebody. The database cannot catch this — the two
 * columns are individually valid — and the operator cannot see it, because
 * each half looks right on its own screen section.
 */
export class ArrivalNeverReleasesError extends BusinessRuleError {
  constructor() {
    super({
      code: 'guest_journey.arrival_never_releases',
      message:
        'arrival_release is after_contract while contract_mode is disabled',
      userMessage:
        'בחרת לשחרר את פרטי ההגעה רק אחרי חתימה על חוזה, אך החוזה כבוי — כך אף אורח לא יקבל את הכתובת לעולם. הפעל חוזה, או בחר מועד שחרור אחר.',
    })
  }
}

/** `guest_journey_settings_review_has_url`, refused in words a person can act on. */
export class ReviewWithoutLinkError extends BusinessRuleError {
  constructor() {
    super({
      code: 'guest_journey.review_without_link',
      message: 'review_enabled is true with no review_url',
      userMessage:
        'בקשת ביקורת בלי קישור היא שלב ריק בעמוד האורח. הזן קישור לעמוד הביקורות, או כבה את בקשת הביקורת.',
    })
  }
}

export class ReviewLinkNotAUrlError extends BusinessRuleError {
  constructor(value: string) {
    super({
      code: 'guest_journey.review_link_invalid',
      message: `review_url is not an http(s) URL: ${value}`,
      userMessage:
        'הקישור לביקורת חייב להתחיל ב-https:// כדי שהאורח יגיע לאן שהתכוונתם.',
    })
  }
}

/** The same field asked for twice, once as required and once as optional. */
export class DetailFieldAskedTwiceError extends BusinessRuleError {
  constructor(fields: readonly string[]) {
    super({
      code: 'guest_journey.detail_field_twice',
      message: `fields are both required and optional: ${fields.join(', ')}`,
      userMessage:
        'שדה אחד לא יכול להיות גם חובה וגם רשות — האורח יראה אותו פעמיים. הסר אותו מאחת הרשימות.',
      publicDetails: { fields: [...fields] },
    })
  }
}

/** Requests switched on with nothing that may be requested. */
export class RequestsWithoutCategoriesError extends BusinessRuleError {
  constructor() {
    super({
      code: 'guest_journey.requests_without_categories',
      message: 'requests_enabled is true with an empty request_categories',
      userMessage:
        'הפעלת בקשות בלי אף סוג בקשה נותנת לאורח טופס שאי אפשר לשלוח. בחר לפחות סוג אחד, או כבה את הבקשות.',
    })
  }
}

function assertSettingsCoherent(input: GuestJourneySettings): void {
  if (
    input.arrivalRelease === 'after_contract' &&
    input.contractMode === 'disabled'
  ) {
    throw new ArrivalNeverReleasesError()
  }

  const url = input.reviewUrl?.trim() ?? ''
  if (input.reviewEnabled && url.length === 0)
    throw new ReviewWithoutLinkError()
  if (url.length > 0 && !/^https?:\/\//i.test(url)) {
    throw new ReviewLinkNotAUrlError(url)
  }

  const optional = new Set<string>(input.optionalDetailFields)
  const twice = input.requiredDetailFields.filter((field) =>
    optional.has(field),
  )
  if (twice.length > 0) throw new DetailFieldAskedTwiceError(twice)

  if (input.requestsEnabled && input.requestCategories.length === 0) {
    throw new RequestsWithoutCategoriesError()
  }
}

/* ------------------------------------------------------------ the build -- */

/**
 * The scope a settings row belongs to.
 *
 * A property row carries its property, so a member narrowed to two properties
 * may configure those two and no others. The organization default carries
 * none, and `withinScope` answers false for a narrowed membership asked about
 * a resource with no property — which is the right answer: somebody who can
 * see two houses does not get to change the default every house inherits.
 */
function scopeFor(organizationId: string, propertyId: string | null): Resource {
  return propertyId === null
    ? { organizationId, family: 'settings' }
    : { organizationId, propertyId, family: 'settings' }
}

export type JourneySettingsOperations = {
  saveSettings: Operation<
    JourneySettingsInput,
    JourneySettingsRecord | null,
    JourneySettingsRecord
  >
  saveContent: Operation<
    JourneyContentInput,
    JourneyContent | null,
    JourneyContent
  >
  applyPreset: Operation<
    ApplyPresetInput,
    JourneySettingsRecord | null,
    ApplyPresetResult
  >
  clearPropertySettings: Operation<
    { propertyId: string },
    JourneySettingsRecord | null,
    { propertyId: string }
  >
}

export function defineJourneySettingsOperations(deps: {
  repository: JourneySettingsRepository
}): JourneySettingsOperations {
  const { repository } = deps

  /**
   * The load every one of these shares.
   *
   * It never returns null. `defineOperation` turns a null load into a 404, and
   * "this business has not configured its guest journey yet" is the ordinary
   * first state rather than a missing record. The resource is returned anyway
   * so that the second `assertCan` — the one that settles tenant and scope —
   * still runs, which is the whole reason to declare a load at all.
   */
  async function loadScope(organizationId: string, propertyId: string | null) {
    const entity = await repository.loadSettings(organizationId, propertyId)
    return {
      resource: scopeFor(organizationId, propertyId),
      entity,
      version: entity?.version,
    }
  }

  const saveSettings = defineOperation<
    JourneySettingsInput,
    JourneySettingsRecord | null,
    JourneySettingsRecord
  >({
    name: 'guest_journey.settings.save',
    permission: 'organization.settings.edit',
    resourceType: 'guest_journey_settings',
    input: SETTINGS_INPUT,
    requiresReason: false,

    loadResource: ({ input, context }) =>
      loadScope(context.actor.organizationId, input.propertyId),

    rule({ input, context }) {
      assertCan(
        context.actor,
        'organization.settings.edit',
        scopeFor(context.actor.organizationId, input.propertyId),
      )
      assertSettingsCoherent(input)
    },

    async execute({ input, context, tx }) {
      return repository.saveSettings(
        context.actor.organizationId,
        { ...input, reviewUrl: normalizeUrl(input.reviewUrl) },
        context.actor.userId,
        tx,
      )
    },

    audit({ entity, result, input, context }) {
      const before = entity ? stripRecord(entity) : SHIPPED_JOURNEY_SETTINGS
      const changes = describeChanges(before, stripRecord(result))
      const scope = input.propertyId === null ? 'לכל הארגון' : 'לנכס אחד'

      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        before,
        after: stripRecord(result),
        summary:
          `${context.auditActor.label} עדכנה את מסע האורח ${scope}: ` +
          (changes.length === 0
            ? 'ללא שינוי בערכים'
            : changes
                .map(
                  (change) => `${change.label} — ${change.from} ← ${change.to}`,
                )
                .join('; ')),
      }
    },
  })

  const saveContent = defineOperation<
    JourneyContentInput,
    JourneyContent | null,
    JourneyContent
  >({
    name: 'guest_journey.content.save',
    permission: 'organization.settings.edit',
    resourceType: 'guest_journey_content',
    input: CONTENT_INPUT,
    requiresReason: false,

    async loadResource({ input, context }) {
      const entity = await repository.loadContent(
        context.actor.organizationId,
        input.propertyId,
      )
      return {
        resource: scopeFor(context.actor.organizationId, input.propertyId),
        entity,
        version: entity?.version,
      }
    },

    rule({ input, context }) {
      assertCan(
        context.actor,
        'organization.settings.edit',
        scopeFor(context.actor.organizationId, input.propertyId),
      )
    },

    async execute({ input, context, tx }) {
      // Absent is null, never `''`. An empty string is a value: it would make
      // `access_code` present-and-blank, and 0034 gates on null.
      const draft: JourneyContentDraft = {
        propertyId: input.propertyId,
        addressNote: normalizeText(input.addressNote),
        directions: normalizeText(input.directions),
        mapUrl: normalizeText(input.mapUrl),
        accessInstructions: normalizeText(input.accessInstructions),
        accessCode: normalizeText(input.accessCode),
        parking: normalizeText(input.parking),
        wifiNetwork: normalizeText(input.wifiNetwork),
        wifiPassword: normalizeText(input.wifiPassword),
        propertyGuide: normalizeText(input.propertyGuide),
        emergencyContact: normalizeText(input.emergencyContact),
        checkoutInstructions: normalizeText(input.checkoutInstructions),
      }

      return repository.saveContent(
        context.actor.organizationId,
        draft,
        context.actor.userId,
        tx,
      )
    },

    /**
     * What changed, never what it changed to.
     *
     * `access_code` and `wifi_password` are in this record, and an audit row
     * carrying the door code would put it in the one table the whole team
     * reads. So the descriptor names the fields that were touched and the
     * pipeline is handed no values at all.
     */
    audit({ entity, result, context }) {
      const touched = CONTENT_FIELD_LABELS.filter(
        ([field]) => (entity?.[field] ?? null) !== (result[field] ?? null),
      ).map(([, label]) => label)

      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary:
          `${context.auditActor.label} עדכנה את תוכן מסע האורח בנכס: ` +
          (touched.length === 0 ? 'ללא שינוי' : touched.join(', ')),
      }
    },
  })

  const applyPreset = defineOperation<
    ApplyPresetInput,
    JourneySettingsRecord | null,
    ApplyPresetResult
  >({
    name: 'guest_journey.preset.apply',
    permission: 'organization.settings.edit',
    resourceType: 'guest_journey_settings',
    input: PRESET_INPUT,
    requiresReason: false,

    loadResource: ({ input, context }) =>
      loadScope(context.actor.organizationId, input.propertyId),

    rule({ input, context, entity }) {
      assertCan(
        context.actor,
        'organization.settings.edit',
        scopeFor(context.actor.organizationId, input.propertyId),
      )

      const preset = presetById(input.presetId)
      if (!preset) throw new UnknownPresetError(input.presetId)

      // The same resolution the screen showed before the button was pressed,
      // checked against the same rules a hand edit passes. A preset that could
      // save something a person could not type is a back door.
      assertSettingsCoherent(
        resolvePreset(
          entity ? stripRecord(entity) : SHIPPED_JOURNEY_SETTINGS,
          preset,
        ).settings,
      )
    },

    async execute({ input, entity, context, tx }) {
      const preset = presetById(input.presetId)
      if (!preset) throw new UnknownPresetError(input.presetId)

      const current = entity ? stripRecord(entity) : SHIPPED_JOURNEY_SETTINGS
      const resolution = resolvePreset(current, preset)

      // Idempotent, and visibly so: applying the same preset twice writes
      // nothing the second time and still records that somebody applied it.
      if (entity && resolution.changes.length === 0) {
        return { settings: entity, changes: [], notes: resolution.notes }
      }

      const settings = await repository.saveSettings(
        context.actor.organizationId,
        { ...resolution.settings, propertyId: input.propertyId },
        context.actor.userId,
        tx,
      )

      return { settings, changes: resolution.changes, notes: resolution.notes }
    },

    audit({ entity, input, result, context }) {
      const preset = presetById(input.presetId)
      return {
        resourceId: result.settings.id,
        propertyId: result.settings.propertyId,
        before: entity ? stripRecord(entity) : SHIPPED_JOURNEY_SETTINGS,
        after: stripRecord(result.settings),
        summary:
          `${context.auditActor.label} החילה את התבנית ` +
          `"${preset?.label ?? input.presetId}" על מסע האורח ` +
          `${input.propertyId === null ? 'לכל הארגון' : 'לנכס אחד'}: ` +
          (result.changes.length === 0
            ? 'ללא שינוי — ההגדרות כבר תאמו את התבנית'
            : `${result.changes.length} שינויים`),
      }
    },
  })

  const clearPropertySettings = defineOperation<
    { propertyId: string },
    JourneySettingsRecord | null,
    { propertyId: string }
  >({
    name: 'guest_journey.settings.clear',
    permission: 'organization.settings.edit',
    resourceType: 'guest_journey_settings',
    input: s.object({ propertyId: s.uuid({ label: 'נכס' }) }),
    requiresReason: false,

    loadResource: ({ input, context }) =>
      loadScope(context.actor.organizationId, input.propertyId),

    rule({ input, context }) {
      assertCan(
        context.actor,
        'organization.settings.edit',
        scopeFor(context.actor.organizationId, input.propertyId),
      )
    },

    async execute({ input, context, tx }) {
      await repository.clearSettings(
        context.actor.organizationId,
        input.propertyId,
        tx,
      )
      return { propertyId: input.propertyId }
    },

    audit({ entity, input, context }) {
      return {
        propertyId: input.propertyId,
        before: entity ? stripRecord(entity) : null,
        summary:
          `${context.auditActor.label} ביטלה את ההגדרות הייעודיות של הנכס — ` +
          'מעתה הוא יורש את ברירת המחדל של הארגון',
      }
    },
  })

  return { saveSettings, saveContent, applyPreset, clearPropertySettings }
}

export class UnknownPresetError extends BusinessRuleError {
  constructor(id: string) {
    super({
      code: 'guest_journey.unknown_preset',
      message: `no preset with id ${id}`,
      userMessage: 'התבנית שנבחרה אינה מוכרת. רענן את הדף ובחר מהרשימה.',
    })
  }
}

/** Empty is not a value. A review link saved as `''` fails the check constraint. */
function normalizeUrl(value: string | null): string | null {
  return normalizeText(value)
}

function normalizeText(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Which content fields exist, and what to call them in an audit summary.
 *
 * The values are deliberately absent from that summary — see `saveContent`.
 */
const CONTENT_FIELD_LABELS: readonly [keyof JourneyContent, string][] = [
  ['addressNote', 'הערת כתובת'],
  ['directions', 'הוראות הגעה'],
  ['mapUrl', 'קישור למפה'],
  ['accessInstructions', 'הוראות כניסה'],
  ['accessCode', 'קוד כניסה'],
  ['parking', 'חניה'],
  ['wifiNetwork', 'שם הרשת'],
  ['wifiPassword', 'סיסמת הרשת'],
  ['propertyGuide', 'מדריך הנכס'],
  ['emergencyContact', 'איש קשר לחירום'],
  ['checkoutInstructions', 'הוראות יציאה'],
]
