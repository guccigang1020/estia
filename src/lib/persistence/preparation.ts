/**
 * `PreparationPorts`, backed by `0011_operations.sql` and `0021_preparation.sql`.
 *
 * ── What each port reads ──────────────────────────────────────────────────
 *
 *   `loadStock`              → `public.inventory_items`
 *   `loadTransferrableStock` → the same table, elsewhere in the organization
 *   `loadCatalogue`          → `public.preparation_catalogues`
 *   `loadSnapshot`           → `public.preparation_snapshots`
 *   `loadPlan` / `savePlan`  → `public.work_plans`
 *   `nextPlanId`             → not storage at all
 *
 * ── Why these are three tables and not a projection onto `tasks` ──────────
 *
 * The temptation was always to project a work plan onto `tasks`: a plan is a
 * list of jobs, a task is a job, and the mapping almost writes itself. 0021
 * did not take it, and its header says why in the same words this file used to
 * refuse in. A `WorkPlan` is a *versioned computed artefact* with a frozen
 * `PreparationSnapshot` beside it, and the snapshot is the entire mechanism
 * that stops historical drift — it is why a plan built in March still costs
 * what it cost in March after the catalogue's prices change in April. `tasks`
 * has no revision chain and nothing to freeze a catalogue into.
 *
 * `operations.ts` makes the same point structurally: it deliberately has no
 * `loadCatalogue(bookingId)`, so that every path except a brand-new plan is
 * *forced* through the stored snapshot. `preparation_snapshots` is append-only
 * by trigger — against `service_role` and `postgres` too, which RLS cannot do
 * — so that guarantee is now the database's rather than this file's.
 *
 * ── `work_plans.version` is not `tg_touch_row`'s ──────────────────────────
 *
 * It is the domain's plan revision, written by the caller. 0021 gave the table
 * `tg_touch_updated_at` rather than `tg_touch_row` for exactly this reason, and
 * a trigger refuses an update that lowers it. So `savePlan` **sends** `version`
 * — the opposite of every other write in this directory — and does not use it
 * as an optimistic predicate, because the domain already advanced it before the
 * record arrived and locking on it would refuse every revision.
 *
 * ── Two ports still have nowhere to read from ─────────────────────────────
 *
 * `loadBooking` and `loadAllocationContexts`. Neither is a table 0021 forgot;
 * both want facts nothing in the schema records. They still raise
 * `SchemaNotProvisionedError` — never `null` and never `[]`, which would look
 * like a booking with no extras and a month with no occupancy rather than a
 * deployment that cannot answer.
 */

import { INVENTORY_STATES } from '../contracts/states'
import { PROPERTY_TIME_ZONE } from '../booking/dates'
import { PRICE_LINE_KINDS, type PriceLine } from '../booking/types'
import type { FixedAllocationInput } from '../preparation/costing'
import { sleepingExtras } from '../preparation/intake'
import {
  EVENT_TYPES,
  type PreparationBooking,
  type PreparationCatalogue,
  type PreparationSnapshot,
  type SleepingShape,
  type StockLevel,
  type WorkPlan,
} from '../preparation/types'
import type { PreparationCataloguePorts } from '../preparation/catalogue'
import type { PreparationPorts } from '../preparation/operations'
import type { TransactionHandle } from '../service'
import { ConflictError, NotFoundError } from '../errors'
import type { Db, Row } from './client'
import { SchemaNotProvisionedError } from './errors'
import {
  RowShapeError,
  asEnum,
  asIsoDate,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  toRow,
  toRows,
} from './mapping'
import { clientFor, recordWrite } from './transaction'

const STOCK_COLUMNS =
  'id, organization_id, property_id, name, state, quantity, ' +
  'quantity_reserved, min_quantity'

/** The catalogue is its jsonb parts. Every one is `NOT NULL DEFAULT`. */
const CATALOGUE_COLUMNS =
  'organization_id, property_id, bed_types, rules, event_templates, ' +
  'property_configuration, variable_costs, fixed_costs, commission_rules, ' +
  'complexity, readiness_policy, section_labels'

const SNAPSHOT_COLUMNS =
  'organization_id, property_id, booking_id, hash, captured_at, ' +
  'effective_on, bed_types, rules, event_templates, property_configuration, ' +
  'variable_costs, fixed_costs, commission_rule, complexity, ' +
  'readiness_policy, section_labels, price_lines'

const PLAN_COLUMNS =
  'id, organization_id, property_id, unit_id, booking_id, version, ' +
  'snapshot_hash, sections, critical_path_minutes, recommended_staff, ' +
  'created_at'

/**
 * The slice of a booking preparation reads. Deliberately not `*`.
 *
 * A guest's name, their telephone number and the channel payload are all on
 * this row and none of them is any of this module's business — see the header
 * of `PreparationBooking`. Naming the columns is what keeps that true as the
 * table grows.
 */
const PREPARATION_BOOKING_COLUMNS =
  'id, organization_id, property_id, unit_id, check_in, check_out, ' +
  'arrival_time, adults, children, infants, couples, extra_beds_requested, ' +
  'cots_requested, event_type, special_requests'

export interface PreparationPlanContext {
  /** The number a person quotes on the telephone. */
  reference: string | null
  propertyName: string | null
  unitName: string | null
}

/** A booking that is not there, or not readable. Never a half-filled object. */
const EMPTY_PLAN_CONTEXT: PreparationPlanContext = {
  reference: null,
  propertyName: null,
  unitName: null,
}

/** The earliest a guest could arrive. The safe deadline when nothing is set. */
const START_OF_DAY = '00:00:00'

/**
 * A property-local date and time, as a UTC instant.
 *
 * `bookings.arrival_time` and `units.check_in_time` are `time` columns with no
 * zone on them, and the date beside them is a `date`. Composing the two into
 * an instant needs a zone, and the only correct one is the property's — a
 * server reading "15:00" as UTC puts a Jerusalem afternoon arrival two or
 * three hours earlier than it is, and every readiness countdown in the product
 * is measured from it.
 *
 * The offset is asked of `Intl` for that exact day rather than hard-coded,
 * because Israel changes it twice a year. The one case this gets wrong is a
 * time inside the hour a clock change skips or repeats, which no guest house
 * schedules an arrival in.
 */
function atLocalTime(date: string, time: string): string {
  const clock = time.length === 'HH:MM'.length ? `${time}:00` : time.slice(0, 8)
  return new Date(`${date}T${clock}${offsetOn(date)}`).toISOString()
}

/** `+03:00` for that date in the property's zone. */
function offsetOn(date: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PROPERTY_TIME_ZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(`${date}T12:00:00Z`))

  const named = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  const offset = named.replace('GMT', '')

  // `GMT` on its own means UTC, which `Date` will not parse from an empty
  // suffix. Anything unrecognised falls back to `Z` for the same reason: a
  // string that does not parse produces `Invalid Date`, and a NaN instant
  // silently disables every countdown rather than failing loudly.
  return /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : 'Z'
}

export class SupabasePreparationPorts
  implements PreparationPorts, PreparationCataloguePorts
{
  constructor(private readonly db: Db) {}

  /**
   * What this property has.
   *
   * Note the signature: `loadStock(propertyId)` takes no organization. That is
   * not an omission in the port — RLS is what scopes it, and `inventory_items`
   * carries `organization_id` with a policy over `my_organizations()`. A
   * property id from another tenant returns nothing rather than somebody
   * else's linen cupboard.
   *
   * Soft-deleted rows are excluded. A deleted item is not stock.
   */
  async loadStock(propertyId: string): Promise<readonly StockLevel[]> {
    const { data, error } = await this.db
      .from('inventory_items')
      .select(STOCK_COLUMNS)
      .eq('property_id', propertyId)
      .is('deleted_at', null)
      .order('name', { ascending: true })

    if (error) throw error
    return toRows(data).map(toStockLevel)
  }

  /**
   * Stock that exists elsewhere in the organization and could be moved.
   *
   * Optional on the port, and worth implementing: the alternative to a
   * transfer suggestion is a purchase, and a business that owns forty spare
   * towels in the next village should be told before it buys more.
   */
  async loadTransferrableStock(
    organizationId: string,
    excludingPropertyId: string,
  ): Promise<readonly StockLevel[]> {
    const { data, error } = await this.db
      .from('inventory_items')
      .select(STOCK_COLUMNS)
      .eq('organization_id', organizationId)
      .neq('property_id', excludingPropertyId)
      .is('deleted_at', null)
      .order('name', { ascending: true })

    if (error) throw error
    return toRows(data).map(toStockLevel)
  }

  /**
   * A fresh plan id. Not storage, so nothing blocks it.
   *
   * `randomUUID` rather than something derived from the booking: a booking can
   * have several plans over its life — a rebuild after the party size changes —
   * and an id derived from the booking would collide with the plan it is meant
   * to supersede.
   */
  nextPlanId(): string {
    return crypto.randomUUID()
  }

  // ── The catalogue, the snapshot and the plan ────────────────────────────

  /**
   * The live configuration for one property.
   *
   * `(organization_id, property_id)` is unique, so `maybeSingle` is the whole
   * query. A property with nothing configured returns `null`, and
   * `buildPlan` turns that into a `NotFoundError` naming the property — which
   * is the right answer, because "nobody has set up preparation here yet" is
   * an ordinary state with an ordinary remedy.
   */
  async loadCatalogue(
    organizationId: string,
    propertyId: string,
  ): Promise<PreparationCatalogue | null> {
    const { data, error } = await this.db
      .from('preparation_catalogues')
      .select(CATALOGUE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (error) throw error
    return data ? toCatalogue(toRow(data)) : null
  }

  /**
   * The row's revision, or `null` where there is no row.
   *
   * Asked separately from `loadCatalogue` because `PreparationCatalogue` has
   * no version field and must not grow one: `captureSnapshot` hashes exactly
   * that object, and a bookkeeping column inside it would change the hash
   * every time somebody re-saved an unchanged policy — which would make "did
   * the rules move between these two bookings" answer yes when nothing had.
   */
  async catalogueVersion(
    organizationId: string,
    propertyId: string,
  ): Promise<number | null> {
    const { data, error } = await this.db
      .from('preparation_catalogues')
      .select('version')
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (error) throw error
    return data ? asNumber(toRow(data), 'version') : null
  }

  /**
   * Write the live configuration for one property.
   *
   * Insert or update, chosen by `expectedVersion` rather than by an upsert —
   * the same argument `savePlan` makes above. PostgREST compiles an upsert
   * into `insert … on conflict do update`, which needs both policies, and 0021
   * gates the two on the same permission but as separate policies; more to the
   * point, an upsert has nowhere to put the version predicate, so two people
   * editing the same policy would silently take turns overwriting each other.
   *
   * `version` is never sent. `tg_touch_row` owns it, and the `.eq('version')`
   * on the update is the whole optimistic lock: an update that matches no row
   * is a revision that moved underneath the caller, and it is reported as a
   * conflict rather than retried — the person has a form full of edits and
   * needs to be told, not to have them silently applied on top of somebody
   * else's.
   */
  async saveCatalogue(
    input: {
      organizationId: string
      propertyId: string
      catalogue: PreparationCatalogue
      expectedVersion: number | null
    },
    tx: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)
    const { catalogue } = input

    const parts = {
      bed_types: catalogue.bedTypes,
      rules: catalogue.rules,
      event_templates: catalogue.eventTemplates,
      property_configuration: catalogue.propertyConfiguration,
      variable_costs: catalogue.variableCosts,
      fixed_costs: catalogue.fixedCosts,
      commission_rules: catalogue.commissionRules,
      complexity: catalogue.complexity,
      readiness_policy: catalogue.readinessPolicy,
      section_labels: catalogue.sectionLabels,
    }

    if (input.expectedVersion === null) {
      const { error } = await db.from('preparation_catalogues').insert({
        organization_id: input.organizationId,
        property_id: input.propertyId,
        ...parts,
      })
      if (error) throw error
    } else {
      const { data, error } = await db
        .from('preparation_catalogues')
        .update(parts)
        .eq('organization_id', input.organizationId)
        .eq('property_id', input.propertyId)
        .eq('version', input.expectedVersion)
        .select('id')

      if (error) throw error

      if (toRows(data).length === 0) {
        throw new ConflictError({
          resourceType: 'preparation_catalogue',
          resourceId: input.propertyId,
          expectedVersion: input.expectedVersion,
          actualVersion: await this.catalogueVersion(
            input.organizationId,
            input.propertyId,
          ),
          userMessage:
            'מדיניות ההכנה של הנכס שונתה בינתיים על ידי מישהו אחר. רענן את המסך כדי לראות את הגרסה הנוכחית לפני שתשמור שוב.',
        })
      }
    }

    recordWrite(tx, `preparation_catalogues(${input.propertyId})`)
  }

  /**
   * The frozen ruleset this booking was computed against.
   *
   * One row per booking — `preparation_snapshots_booking_key` — and the table
   * is append-only, so there is no "newest capture" to choose between. No
   * organization filter is possible or needed: the port passes only a booking
   * id, and `preparation_snapshots_select` scopes the read to the caller's
   * organizations and property scope.
   */
  async loadSnapshot(bookingId: string): Promise<PreparationSnapshot | null> {
    const { data, error } = await this.db
      .from('preparation_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? toSnapshot(toRow(data)) : null
  }

  async loadPlan(bookingId: string): Promise<WorkPlan | null> {
    const { data, error } = await this.db
      .from('work_plans')
      .select(PLAN_COLUMNS)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? toPlan(toRow(data)) : null
  }

  /**
   * Store a plan: update if it is there, insert if it is not.
   *
   * Deliberately not an upsert. PostgREST compiles one into
   * `insert … on conflict do update`, which needs *both* the insert and the
   * update policy — and 0021 separates them on purpose: creating a plan is
   * `task.create`, advancing one is `task.update`/`complete`/`verify`. A
   * cleaner ticking off a section holds the second and not the first, and an
   * upsert would refuse them for a row they are entitled to change.
   *
   * `version` is written, unlike everywhere else in this directory. It is the
   * domain's plan revision — `work_plans` carries `tg_touch_updated_at` and not
   * `tg_touch_row` — and `tg_work_plans_record_version` copies each revision
   * into `work_plan_versions`, which is what makes a `PlanDelta` answerable
   * three weeks later. A separate trigger refuses a version that moves
   * backwards, which is the failure that actually matters here: silently
   * discarding a revision.
   */
  async savePlan(plan: WorkPlan, tx: TransactionHandle): Promise<void> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('work_plans')
      .update({
        version: plan.version,
        snapshot_hash: plan.snapshotHash,
        sections: plan.sections,
        critical_path_minutes: plan.criticalPathMinutes,
        recommended_staff: plan.recommendedStaff,
      })
      .eq('id', plan.id)
      .eq('organization_id', plan.organizationId)
      .select('id')

    if (error) throw error

    if (toRows(data).length === 0) {
      const inserted = await db.from('work_plans').insert({
        id: plan.id,
        organization_id: plan.organizationId,
        property_id: plan.propertyId,
        unit_id: plan.unitId,
        booking_id: plan.bookingId,
        version: plan.version,
        snapshot_hash: plan.snapshotHash,
        sections: plan.sections,
        critical_path_minutes: plan.criticalPathMinutes,
        recommended_staff: plan.recommendedStaff,
        created_at: plan.createdAt,
      })
      if (inserted.error) throw inserted.error
    }

    recordWrite(tx, `work_plans(${plan.id})`)
  }

  /**
   * Freeze the catalogue against a booking. Once, and never again.
   *
   * `property_id` is read from the booking rather than taken from the caller:
   * the column is `NOT NULL` because both foreign keys are checked against it,
   * and `PreparationSnapshot` has no property field. Reading it from a row we
   * already name is the move `finance.ts` makes for a payment with no property
   * — the fact exists, so fetching it is not a guess. Inventing it would let a
   * snapshot claim a booking belongs to a property it does not.
   *
   * A plain insert, because the table refuses updates and deletes by trigger. A
   * second capture for the same booking fails on
   * `preparation_snapshots_booking_key`, loudly, which is what should happen:
   * the whole point of the record is that it does not move.
   */
  async saveSnapshot(
    bookingId: string,
    snapshot: PreparationSnapshot,
    tx: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db.from('preparation_snapshots').insert({
      organization_id: snapshot.organizationId,
      property_id: await this.propertyOf(db, bookingId),
      booking_id: bookingId,
      hash: snapshot.hash,
      captured_at: snapshot.capturedAt,
      effective_on: snapshot.effectiveOn,
      bed_types: snapshot.bedTypes,
      rules: snapshot.rules,
      event_templates: snapshot.eventTemplates,
      property_configuration: snapshot.propertyConfiguration,
      variable_costs: snapshot.variableCosts,
      fixed_costs: snapshot.fixedCosts,
      commission_rule: snapshot.commissionRule,
      complexity: snapshot.complexity,
      readiness_policy: snapshot.readinessPolicy,
      section_labels: snapshot.sectionLabels,
      price_lines: snapshot.priceLines,
    })

    if (error) throw error
    recordWrite(tx, `preparation_snapshots(${bookingId})`)
  }

  // ── The booking a plan is built for ─────────────────────────────────────

  /**
   * The stay, measured. Unblocked by 0028.
   *
   * This port used to raise `SchemaNotProvisionedError`, and the reason it
   * gave was accurate: `PreparationBooking` carries the event type, the
   * sleeping request and the extras, and `bookings` had a column for none of
   * them. 0028 added five — `couples`, `extra_beds_requested`,
   * `cots_requested`, `event_type` and `special_requests` — and the three
   * columns the schema has held since 0009 are now written with the party the
   * desk actually typed rather than with the whole count as adults. So the
   * facts exist, and this reads them instead of refusing.
   *
   * ── What is derived, and from what ────────────────────────────────────
   *
   * **`arrivalAt`** is the only computed field, and it is the deadline every
   * readiness figure is measured against, so it is worth being exact about.
   * It is the check-in *date* at the booking's own `arrival_time` where the
   * guest gave one, otherwise the unit's `check_in_time`, otherwise the
   * property's `default_check_in_time` — the fallback order 0008 set those
   * columns up in. Resolved in `Asia/Jerusalem`, because a UTC reading of
   * "three in the afternoon" is hours out and every countdown on every screen
   * inherits the error.
   *
   * **`extras`** are the requested spare beds and cots, made countable by
   * `sleepingExtras`. That wants the property's own bed catalogue for the
   * Hebrew label and the setup minutes, which is why the catalogue is read
   * here; the alternative is a plan line with no duration and a fallback name.
   * A property with no policy configured yet still gets the lines, without
   * minutes — `buildPlan` refuses for the missing catalogue a moment later,
   * and refusing here instead would hide which of the two is really missing.
   *
   * **`priceLines`** are read and are frequently empty on purpose:
   * `booking_price_lines_select` wants `booking.view_price`, which a cleaner
   * does not hold. They feed the costing engine and nothing a cleaner sees, so
   * an empty list here is the privacy rule working rather than a gap.
   */
  async loadBooking(bookingId: string): Promise<PreparationBooking | null> {
    const { data, error } = await this.db
      .from('bookings')
      .select(PREPARATION_BOOKING_COLUMNS)
      .eq('id', bookingId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    const organizationId = asString(row, 'organization_id')
    const propertyId = asString(row, 'property_id')
    const unitId = asString(row, 'unit_id')

    const [catalogue, arrivalAt, priceLines] = await Promise.all([
      this.loadCatalogue(organizationId, propertyId),
      this.arrivalInstant(row, propertyId, unitId),
      this.loadPriceLines(bookingId),
    ])

    const adults = asNumber(row, 'adults')
    const children = asNumber(row, 'children')
    const infants = asNumber(row, 'infants')

    const sleeping: SleepingShape = {
      couples: asNumber(row, 'couples'),
      extraBedsRequested: asNumber(row, 'extra_beds_requested'),
      cotsRequested: asNumber(row, 'cots_requested'),
    }

    return {
      id: bookingId,
      organizationId,
      propertyId,
      unitId,
      stay: {
        checkIn: asIsoDate(row, 'check_in'),
        checkOut: asIsoDate(row, 'check_out'),
      },
      // Every head, infants included — the number the stay was priced and its
      // capacity checked against. `allocateSleeping` is handed this and will
      // therefore lay out a bed for a baby. That is a known gap in
      // `SleepingAllocationInput`, which takes `{ guests, configuration,
      // bedTypes }` and has nowhere to be told which of them sleep in a cot;
      // subtracting the infants here instead would make the fire count and the
      // bed count disagree, which is the worse of the two errors.
      guests: adults + children + infants,
      adults,
      children,
      eventType: asEnum(row, 'event_type', EVENT_TYPES),
      extras: sleepingExtras({
        sleeping,
        extraBedTypeId:
          catalogue?.propertyConfiguration.extraSleepingBedTypeId ?? null,
        bedTypes: catalogue?.bedTypes ?? [],
      }),
      arrivalAt,
      priceLines,
      specialRequests: asStringOrNull(row, 'special_requests'),
      sleeping,
    }
  }

  /**
   * What the plan screen needs and the engine has no business carrying.
   *
   * The property's and the unit's Hebrew names and the booking's own
   * reference. `PreparationBooking` deliberately holds none of them — its own
   * header says a type that could carry a guest's phone number eventually
   * does — so they are fetched beside it rather than smuggled onto it.
   *
   * Every field is nullable and a name that does not come back stays `null`.
   * Row level security may refuse the unit or the property to this reader, and
   * a truncated uuid under a heading that says "יחידה" is worse than nothing.
   */
  async loadPlanContext(bookingId: string): Promise<PreparationPlanContext> {
    const { data, error } = await this.db
      .from('bookings')
      .select('id, reference, property_id, unit_id')
      .eq('id', bookingId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return EMPTY_PLAN_CONTEXT

    const row = toRow(data)

    const [propertyName, unitName] = await Promise.all([
      this.nameOf('properties', asStringOrNull(row, 'property_id')),
      this.nameOf('units', asStringOrNull(row, 'unit_id')),
    ])

    return {
      reference: asStringOrNull(row, 'reference'),
      propertyName,
      unitName,
    }
  }

  /** One row's `name`, or `null` where this reader may not see it. */
  private async nameOf(
    table: string,
    id: string | null,
  ): Promise<string | null> {
    if (id === null) return null

    const { data, error } = await this.db
      .from(table)
      .select('id, name')
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? asStringOrNull(toRow(data), 'name') : null
  }

  /**
   * The booking's price lines, for the costing engine.
   *
   * Empty for a reader without `booking.view_price`, which is most readers of
   * a preparation screen and every cleaner. See the header.
   */
  private async loadPriceLines(
    bookingId: string,
  ): Promise<readonly PriceLine[]> {
    const { data, error } = await this.db
      .from('booking_price_lines')
      .select('kind, label, amount_agorot, quantity, line_date, sort_order')
      .eq('booking_id', bookingId)
      .order('sort_order', { ascending: true })

    if (error) throw error

    return toRows(data).map((row) => ({
      kind: asEnum(row, 'kind', PRICE_LINE_KINDS),
      label: asString(row, 'label'),
      amount: asNumber(row, 'amount_agorot'),
      quantity: asNumber(row, 'quantity'),
      date: asStringOrNull(row, 'line_date'),
    }))
  }

  /**
   * When the guests actually turn up, as an instant.
   *
   * The booking's own `arrival_time` first — a guest who said they are coming
   * at nine in the evening is the entire reason that column exists — then the
   * unit's, then the property's default. A deployment where none of the three
   * is readable falls back to the start of the property-local day, which is
   * the earliest possible arrival and therefore the safest deadline to work
   * to: it makes the house look late rather than making it look ready.
   */
  private async arrivalInstant(
    row: Row,
    propertyId: string,
    unitId: string,
  ): Promise<string> {
    const checkIn = asIsoDate(row, 'check_in')

    const stated = asStringOrNull(row, 'arrival_time')
    if (stated !== null) return atLocalTime(checkIn, stated)

    const unit = await this.db
      .from('units')
      .select('id, check_in_time')
      .eq('id', unitId)
      .maybeSingle()

    if (unit.error) throw unit.error
    const unitTime = unit.data
      ? asStringOrNull(toRow(unit.data), 'check_in_time')
      : null
    if (unitTime !== null) return atLocalTime(checkIn, unitTime)

    const property = await this.db
      .from('properties')
      .select('id, default_check_in_time')
      .eq('id', propertyId)
      .maybeSingle()

    if (property.error) throw property.error
    const propertyTime = property.data
      ? asStringOrNull(toRow(property.data), 'default_check_in_time')
      : null

    return atLocalTime(checkIn, propertyTime ?? START_OF_DAY)
  }

  // ── Blocked, and not on a table somebody forgot ─────────────────────────

  /**
   * Blocked. These are measurements of a month, and nothing measures it.
   *
   * `AllocationContext` is the set of denominators a fixed cost is divided by
   * — days in the period, nights sold, bookings taken, guests hosted, revenue
   * earned, units available. The domain's own comment says they are *measured
   * facts, not estimates*, which is why they are supplied rather than computed
   * inside the costing engine.
   *
   * Assembling them here from `bookings` would be this adapter deciding what
   * counts: whether a cancelled booking is a booking, whether a comped night is
   * occupied, whether revenue means gross or net. Each of those is a business
   * rule, each changes the number on an owner's statement, and none of them
   * belongs in a mapping layer. What is missing is the rule, not the storage.
   */
  async loadAllocationContexts(): Promise<FixedAllocationInput['contexts']> {
    throw blocked(
      'a stored or derived period occupancy summary',
      'spreading a fixed cost across the stays that should carry it. ' +
        'AllocationContext is six measured facts about a period — days, ' +
        'occupied nights, bookings, guests, revenue and units — and deciding ' +
        'whether a cancelled booking counts is a business rule this layer ' +
        'must not invent',
    )
  }

  /** The property a booking belongs to. See `saveSnapshot`. */
  private async propertyOf(db: Db, bookingId: string): Promise<string> {
    const { data, error } = await db
      .from('bookings')
      .select('property_id')
      .eq('id', bookingId)
      .maybeSingle()

    if (error) throw error
    if (!data) throw new NotFoundError('booking', bookingId)
    return asString(toRow(data), 'property_id')
  }
}

// ── Row mapping ───────────────────────────────────────────────────────────

/**
 * One row is one item in one state.
 *
 * `byState` therefore has exactly one key. That is faithful rather than
 * convenient: `inventory_items` has no stable identity above the row — no
 * sku-level key that survives a state change — so a business tracking linen as
 * several rows per sku sees them here as several items, which is what the
 * table actually says. Summing rows by `sku` to synthesise one item with a
 * spread across states would be inventing an identity the schema does not
 * have, and the linen cycle in `inventory.ts` would then be moving quantities
 * between rows that no foreign key connects.
 */
function toStockLevel(row: Row): StockLevel {
  return {
    itemId: asString(row, 'id'),
    label: asString(row, 'name'),
    location: { kind: 'property', propertyId: asString(row, 'property_id') },
    onHand: asNumber(row, 'quantity'),
    reserved: asNumber(row, 'quantity_reserved'),
    // `min_quantity` is the floor a business keeps for the booking it has not
    // taken yet — which is what `safetyStock` means. `par_level` is the target
    // to reorder *up to*, a different number, and using it would report a
    // safety breach every time stock dipped below the reorder point.
    safetyStock: asNumberOrNull(row, 'min_quantity') ?? 0,
    byState: {
      [asEnum(row, 'state', INVENTORY_STATES)]: asNumber(row, 'quantity'),
    },
  }
}

/**
 * The jsonb columns are carried through, not reassembled.
 *
 * Every one of them holds a domain value the domain itself wrote — a rule, a
 * cost model, a set of section labels — and 0021 constrains the *shape* of each
 * with a `jsonb_typeof` CHECK so an object cannot arrive where an array
 * belongs. Re-validating each field here would be a second copy of types that
 * already exist in `src/lib/preparation/types.ts`, and the copy is what drifts.
 *
 * What is checked is the boundary: an array column that is not an array, or an
 * object column that is not an object, fails here rather than three layers up.
 */
function jsonArray<T>(row: Row, column: string): readonly T[] {
  const value = row[column]
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    throw new RowShapeError(column, 'a json array', value)
  }
  return value as T[]
}

function toCatalogue(row: Row): PreparationCatalogue {
  return {
    organizationId: asString(row, 'organization_id'),
    bedTypes: jsonArray(row, 'bed_types'),
    rules: jsonArray(row, 'rules'),
    eventTemplates: jsonArray(row, 'event_templates'),
    propertyConfiguration: asJsonRecord(
      row,
      'property_configuration',
    ) as unknown as PreparationCatalogue['propertyConfiguration'],
    variableCosts: jsonArray(row, 'variable_costs'),
    fixedCosts: jsonArray(row, 'fixed_costs'),
    commissionRules: jsonArray(row, 'commission_rules'),
    complexity: asJsonRecord(
      row,
      'complexity',
    ) as unknown as PreparationCatalogue['complexity'],
    readinessPolicy: asJsonRecord(
      row,
      'readiness_policy',
    ) as unknown as PreparationCatalogue['readinessPolicy'],
    sectionLabels: asJsonRecord(
      row,
      'section_labels',
    ) as unknown as PreparationCatalogue['sectionLabels'],
  }
}

function toSnapshot(row: Row): PreparationSnapshot {
  return {
    organizationId: asString(row, 'organization_id'),
    hash: asString(row, 'hash'),
    capturedAt: asTimestamp(row, 'captured_at'),
    // A `date`, and it stays a string. Parsing it into an instant would make
    // which rules were in force depend on the server's time zone.
    effectiveOn: asIsoDate(row, 'effective_on'),
    bedTypes: jsonArray(row, 'bed_types'),
    rules: jsonArray(row, 'rules'),
    eventTemplates: jsonArray(row, 'event_templates'),
    propertyConfiguration: asJsonRecord(
      row,
      'property_configuration',
    ) as unknown as PreparationSnapshot['propertyConfiguration'],
    variableCosts: jsonArray(row, 'variable_costs'),
    fixedCosts: jsonArray(row, 'fixed_costs'),
    // Singular and nullable. The catalogue carries every commission rule; the
    // snapshot carries the one that was selected, or none — and `null` here is
    // "no commission on this stay", which is a real answer.
    commissionRule: (row.commission_rule ??
      null) as PreparationSnapshot['commissionRule'],
    complexity: asJsonRecord(
      row,
      'complexity',
    ) as unknown as PreparationSnapshot['complexity'],
    readinessPolicy: asJsonRecord(
      row,
      'readiness_policy',
    ) as unknown as PreparationSnapshot['readinessPolicy'],
    sectionLabels: asJsonRecord(
      row,
      'section_labels',
    ) as unknown as PreparationSnapshot['sectionLabels'],
    priceLines: jsonArray<PriceLine>(row, 'price_lines'),
  }
}

function toPlan(row: Row): WorkPlan {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    bookingId: asString(row, 'booking_id'),
    propertyId: asString(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    // The domain's plan revision, not an optimistic lock. See the header.
    version: asNumber(row, 'version'),
    snapshotHash: asString(row, 'snapshot_hash'),
    createdAt: asTimestamp(row, 'created_at'),
    sections: jsonArray(row, 'sections'),
    criticalPathMinutes: asNumber(row, 'critical_path_minutes'),
    recommendedStaff: asNumber(row, 'recommended_staff'),
  }
}

function blocked(missing: string, purpose: string): SchemaNotProvisionedError {
  return new SchemaNotProvisionedError(missing, purpose)
}
