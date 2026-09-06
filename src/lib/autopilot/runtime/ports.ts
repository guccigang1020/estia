/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The fact sources detection runs on, and the honest list of the ones that do
 * not exist.
 *
 * ── Why this file exists at all ───────────────────────────────────────────
 *
 * Nothing under `signals/` fetches anything, deliberately: every detector is a
 * pure function from already-fetched facts to `Signal[]`, which is what makes
 * "why did ESTIA say the villa is at risk" answerable by reading a test rather
 * than by reproducing a database at 06:00 on a Friday. The consequence is that
 * SOMEBODY has to do the fetching, and until now nobody did — the detectors
 * were nine tested functions with no caller. This is the layer that feeds them,
 * and it is the only place in Autopilot where detection touches I/O.
 *
 * ── `null` means "no source", and it is not the same as "none found" ──────
 *
 * Four of the nine fact shapes cannot be assembled from any table this schema
 * has. Returning an empty array for them would tell detection there are no
 * shortages, no unmet payment requirements, no missing access codes and no
 * empty nights — four confident claims about a world nobody looked at. So they
 * return `null`, `run.ts` reports which detectors it could not run, and the
 * screen can say so. `UNSOURCED_FACTS` carries the reason for each.
 *
 * The same rule applies inside a shape: a field whose table has no column for
 * it stays `null` rather than being guessed at. The one place that costs
 * something today is `LaundryFacts.confirmedAt` — see `loadLaundry`.
 */

import {
  capabilitiesFor,
  defaultInventorySettings,
  type InventorySettings,
} from '@/lib/inventory'
import {
  SupabaseLaundryRepository,
  resolveSettings,
  type LaundrySettings,
} from '@/lib/laundry'
import { settingsOrDefaults } from '@/lib/notifications'
import {
  asBoolean,
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'
import {
  LAUNDRY_STATUSES,
  TASK_STATUSES,
  type TaskStatus,
} from '@/lib/contracts/states'

import type { QuietWindow } from '../policy/quiet-hours'
import type {
  AccessFacts,
  CleaningFacts,
  ContractFacts,
  EmptyNightFacts,
  EnabledModules,
  LaundryFacts,
  MaintenanceFacts,
  PaymentFacts,
  PreparationFacts,
  ShortageFacts,
} from '../signals'

/* --------------------------------------------------------------- scope --- */

/**
 * One organization, one window, one page size.
 *
 * `pageSize` is required and has no default here on purpose: how much of the
 * operation one pass looks at is a deployment decision — a five-minute sweep
 * and a nightly catch-up are different questions — and a number invented in
 * this file would be a business figure inside a module whose whole claim is
 * that it holds none.
 */
export interface FactScope {
  organizationId: string
  /** `null` looks at every property the reader may see. */
  propertyId: string | null
  /** The start of the window. Usually now. */
  from: Date
  /** `from` plus the organization's `lookaheadHours`. */
  to: Date
  modules: EnabledModules
  pageSize: number
}

/**
 * The modules no table records, stated by the caller.
 *
 * `EnabledModules` has no default and that is its point — a `?? true` would
 * silently answer the question the type exists to ask. Laundry, inventory,
 * payments, preparation, contracts and the guest portal all have a settings row
 * to read. These four do not: nothing in the schema says whether a business
 * inspects a unit before it counts as ready, or runs cleanings at all, so the
 * caller says.
 */
export interface StatedModules {
  cleaning: boolean
  inspection: boolean
  maintenance: boolean
  access: boolean
}

/* ----------------------------------------------------- what has no source -- */

/** English, for the report and the screen's own explanation. */
export const UNSOURCED_FACTS: Readonly<Record<string, string>> = {
  payment:
    'PaymentFacts.outstanding is resolveCollectionPolicy output, which needs ' +
    'CollectionFacts. The only assembly of those reads ' +
    'guest_collection_context(p_guest_token) — keyed by a guest capability ' +
    'token, not by an organization and a booking — and it lives in ' +
    'guest-journey, which owns the seam.',
  inventory:
    'ShortageFacts needs required (preparation) against available ' +
    '(inventory) per item per property at an instant. Both engines exist and ' +
    'neither publishes that join: SupabaseInventoryRepository reads demand and ' +
    'reservations, and nothing turns a work plan into per-item requirements ' +
    'for a window.',
  access:
    'AccessFacts.codeRequired and instructionsRequired are both non-nullable ' +
    'booleans and no column records either. Whether a property is entered ' +
    'with a code is not in the schema, and when arrival information counts as ' +
    'released is decided by guest-journey logic rather than by a stored ' +
    'instant.',
  opportunity:
    'EmptyNightFacts.bookable and gapNights are the availability engine’s ' +
    'answer per unit per night. AvailabilitySource answers one range at a ' +
    'time; there is no read that walks a horizon and reports the gaps.',
}

/* ---------------------------------------------------------------- port --- */

/**
 * Everything detection needs, as one port.
 *
 * A port rather than a set of queries so that `run.ts` is exercisable with no
 * Supabase project — which is the same argument `policy/repository.ts` makes
 * for its own two implementations, made the same way on purpose.
 */
export interface AutopilotFactPorts {
  /** The zone deadlines are read in. Wall clock, never UTC. */
  timeZone(organizationId: string): Promise<string>
  quietWindow(organizationId: string): Promise<QuietWindow>
  modules(
    organizationId: string,
    stated: StatedModules,
  ): Promise<EnabledModules>

  loadCleaning(scope: FactScope): Promise<readonly CleaningFacts[]>
  loadMaintenance(scope: FactScope): Promise<readonly MaintenanceFacts[]>
  loadLaundry(scope: FactScope): Promise<readonly LaundryFacts[]>
  loadPreparation(scope: FactScope): Promise<readonly PreparationFacts[]>
  loadContracts(scope: FactScope): Promise<readonly ContractFacts[]>

  /** `null` for every one of these today. See `UNSOURCED_FACTS`. */
  loadPayments(scope: FactScope): Promise<readonly PaymentFacts[] | null>
  loadShortages(scope: FactScope): Promise<readonly ShortageFacts[] | null>
  loadAccess(scope: FactScope): Promise<readonly AccessFacts[] | null>
  loadEmptyNights(scope: FactScope): Promise<readonly EmptyNightFacts[] | null>
}

/* -------------------------------------------------------------- helpers -- */

const ISO_DAY = 10

/** `YYYY-MM-DD` plus `HH:MM:SS` as one instant, or `null` when either is. */
function arrivalInstant(
  checkIn: string | null,
  arrivalTime: string | null,
): string | null {
  if (checkIn === null) return null
  const day = checkIn.slice(0, ISO_DAY)
  // No time on the booking means the hour is not fixed. Assuming one would put
  // a deadline on the screen that nobody agreed to.
  if (arrivalTime === null) return null
  const parsed = new Date(`${day}T${arrivalTime}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function taskStatus(row: Row): TaskStatus {
  return asEnum(row, 'status', TASK_STATUSES)
}

/* -------------------------------------------------------------- adapter -- */

/**
 * The fact sources over the request-scoped client.
 *
 * Every read filters `organization_id` in the query as well as relying on row
 * level security, for the reason `policy/repository.ts` states: the policy is
 * the enforcement, and the filter is what stops a mistake here from becoming a
 * cross-tenant read the first time somebody runs it as `service_role`.
 */
export class SupabaseFactPorts implements AutopilotFactPorts {
  constructor(private readonly db: Db) {}

  /* ── configuration ─────────────────────────────────────────────────── */

  private async notificationSettings(organizationId: string) {
    const { data, error } = await this.db
      .from('notification_settings')
      .select(
        'id, organization_id, enabled_channels, quiet_hours_enabled, ' +
          'quiet_hours_start, quiet_hours_end, timezone, ' +
          'urgent_overrides_quiet_hours, default_escalation_minutes, ' +
          'retain_read_days, version',
      )
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error) throw error
    const row = data === null ? null : toRow(data)

    // One answer to "when may ESTIA disturb people", asked by two modules —
    // see the header of `policy/quiet-hours.ts`. The defaults are the
    // notifications module's own, not a second set invented here.
    return settingsOrDefaults(
      organizationId,
      row === null
        ? null
        : {
            id: asString(row, 'id'),
            organizationId: asString(row, 'organization_id'),
            enabledChannels: [],
            quietHoursEnabled: asBoolean(row, 'quiet_hours_enabled'),
            quietHoursStart: asString(row, 'quiet_hours_start'),
            quietHoursEnd: asString(row, 'quiet_hours_end'),
            timezone: asString(row, 'timezone'),
            urgentOverridesQuietHours: asBoolean(
              row,
              'urgent_overrides_quiet_hours',
            ),
            defaultEscalationMinutes: asNumber(
              row,
              'default_escalation_minutes',
            ),
            retainReadDays: asNumber(row, 'retain_read_days'),
            version: asNumber(row, 'version'),
          },
    )
  }

  async timeZone(organizationId: string): Promise<string> {
    return (await this.notificationSettings(organizationId)).timezone
  }

  async quietWindow(organizationId: string): Promise<QuietWindow> {
    const settings = await this.notificationSettings(organizationId)
    return {
      enabled: settings.quietHoursEnabled,
      start: settings.quietHoursStart,
      end: settings.quietHoursEnd,
      timezone: settings.timezone,
    }
  }

  /**
   * What this organization actually runs.
   *
   * Six of the ten are read from the settings row that owns them; the other
   * four are stated by the caller, because no table records them. Nothing here
   * consults the invoice: an entitlement is what the customer bought and this
   * is what they switched on, and a detector that confused the two would be
   * wrong for every business that holds `operations` and runs no laundry.
   */
  async modules(
    organizationId: string,
    stated: StatedModules,
  ): Promise<EnabledModules> {
    const [laundry, inventory, payments, preparation, journey] =
      await Promise.all([
        this.laundryMode(organizationId),
        this.inventorySettings(organizationId),
        this.hasRow('payment_collection_settings', organizationId),
        this.hasRow('preparation_catalogues', organizationId),
        this.guestJourney(organizationId),
      ])

    return {
      guest_portal: journey !== null,
      contracts: journey !== null && journey.contractMode !== 'disabled',
      payments,
      preparation,
      cleaning: stated.cleaning,
      inspection: stated.inspection,
      maintenance: stated.maintenance,
      access: stated.access,
      laundry,
      // From `capabilitiesFor(settings)`, never from the mode:
      // `inventory/settings.ts` says so in as many words, and two callers
      // deriving "can it reserve" from a mode is two answers.
      inventory: capabilitiesFor(inventory),
    }
  }

  private async laundryMode(
    organizationId: string,
  ): Promise<EnabledModules['laundry']> {
    const rows: readonly LaundrySettings[] =
      await new SupabaseLaundryRepository(this.db).listSettings(organizationId)
    // The organization-wide row, resolved by the domain rather than by a
    // query. A pass covers every property, so the org row is the honest one to
    // read; a property override narrows a property's own signals, not the
    // question of whether the module exists.
    return resolveSettings(organizationId, rows, null).settings.mode
  }

  private async inventorySettings(
    organizationId: string,
  ): Promise<InventorySettings> {
    const { data, error } = await this.db
      .from('inventory_settings')
      .select('mode')
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error) throw error
    const defaults = defaultInventorySettings(organizationId)
    if (data === null) return defaults

    const mode = asStringOrNull(toRow(data), 'mode')
    if (mode === null) return defaults
    return { ...defaults, mode: mode as InventorySettings['mode'] }
  }

  private async guestJourney(
    organizationId: string,
  ): Promise<{ contractMode: string } | null> {
    const { data, error } = await this.db
      .from('guest_journey_settings')
      .select('contract_mode')
      .eq('organization_id', organizationId)
      .is('property_id', null)
      .maybeSingle()

    if (error) throw error
    if (data === null) return null
    return { contractMode: asString(toRow(data), 'contract_mode') }
  }

  private async hasRow(
    table: string,
    organizationId: string,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from(table)
      .select('id')
      .eq('organization_id', organizationId)
      .limit(1)

    if (error) throw error
    return toRows(data ?? []).length > 0
  }

  /* ── labels ────────────────────────────────────────────────────────── */

  /**
   * Property names, for the Hebrew sentence.
   *
   * A signal that says "וילה ים — הכביסה לא תחזור בזמן" is one a person can
   * act on; the same sentence with a uuid in it is one they scroll past.
   */
  private async propertyNames(
    organizationId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const { data, error } = await this.db
      .from('properties')
      .select('id, name')
      .eq('organization_id', organizationId)

    if (error) throw error
    return new Map(
      toRows(data ?? []).map((row) => [
        asString(row, 'id'),
        asString(row, 'name'),
      ]),
    )
  }

  /* ── tasks ─────────────────────────────────────────────────────────── */

  private tasksInWindow(scope: FactScope, taskType: string) {
    let query = this.db
      .from('tasks')
      .select(
        'id, property_id, booking_id, status, assigned_to_user_id, ' +
          'started_at, completed_at, verified_at, due_at, blocked_reason, ' +
          'title, priority',
      )
      .eq('organization_id', scope.organizationId)
      .eq('task_type', taskType)
      .is('deleted_at', null)
      // Half-open, `[from, to)`, exactly as `DateRange` defines a stay. The
      // pass that runs at the horizon must not see the same row twice.
      .lt('due_at', scope.to.toISOString())
      .order('due_at', { ascending: true })
      .limit(scope.pageSize)

    if (scope.propertyId !== null) {
      query = query.eq('property_id', scope.propertyId)
    }
    return query
  }

  /**
   * When each cleaner took the job on.
   *
   * `accepted_at` lives on `task_assignments` and not on the task, because
   * being given a job and taking it are different events with different times —
   * and a board that cannot tell them apart has no idea whether the day is
   * covered.
   */
  private async acceptedAt(
    organizationId: string,
    taskIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (taskIds.length === 0) return new Map()

    const { data, error } = await this.db
      .from('task_assignments')
      .select('task_id, accepted_at')
      .eq('organization_id', organizationId)
      .in('task_id', [...taskIds])
      .is('unassigned_at', null)

    if (error) throw error

    const accepted = new Map<string, string>()
    for (const row of toRows(data ?? [])) {
      const at = asTimestampOrNull(row, 'accepted_at')
      if (at !== null) accepted.set(asString(row, 'task_id'), at)
    }
    return accepted
  }

  async loadCleaning(scope: FactScope): Promise<readonly CleaningFacts[]> {
    const [{ data, error }, names] = await Promise.all([
      this.tasksInWindow(scope, 'cleaning'),
      this.propertyNames(scope.organizationId),
    ])
    if (error) throw error

    const rows = toRows(data ?? [])
    const accepted = await this.acceptedAt(
      scope.organizationId,
      rows.map((row) => asString(row, 'id')),
    )

    return rows.map((row) => {
      const id = asString(row, 'id')
      const propertyId = asStringOrNull(row, 'property_id')
      return {
        taskId: id,
        bookingId: asStringOrNull(row, 'booking_id'),
        propertyId,
        label: names.get(propertyId ?? '') ?? asString(row, 'title'),
        status: taskStatus(row),
        assigneeId: asStringOrNull(row, 'assigned_to_user_id'),
        acceptedAt: accepted.get(id) ?? null,
        startedAt: asTimestampOrNull(row, 'started_at'),
        completedAt: asTimestampOrNull(row, 'completed_at'),
        verifiedAt: asTimestampOrNull(row, 'verified_at'),
        // Whether a unit must be inspected before it counts is a business
        // policy with no column. Stated by the caller, and read here from the
        // modules record it stated it into.
        inspectionRequired: scope.modules.inspection,
        dueAt: asTimestampOrNull(row, 'due_at'),
        blockedReason: asStringOrNull(row, 'blocked_reason'),
      }
    })
  }

  async loadMaintenance(
    scope: FactScope,
  ): Promise<readonly MaintenanceFacts[]> {
    const [{ data, error }, names] = await Promise.all([
      this.tasksInWindow(scope, 'maintenance'),
      this.propertyNames(scope.organizationId),
    ])
    if (error) throw error

    return toRows(data ?? []).map((row) => {
      const propertyId = asStringOrNull(row, 'property_id')
      return {
        issueId: asString(row, 'id'),
        propertyId,
        label: names.get(propertyId ?? '') ?? asString(row, 'title'),
        title: asString(row, 'title'),
        status: taskStatus(row),
        // The business's own flag, never inferred from the wording. `tasks`
        // has no safety column, and `priority` is a queue position rather than
        // a statement about danger — reading `urgent` as "safety critical"
        // would raise the product's highest alarm off a coordinator's guess.
        safetyCritical: false,
        blocksUse: false,
        dueAt: asTimestampOrNull(row, 'due_at'),
        // The next arrival is a booking question, and the maintenance read
        // does not join one. Absent rather than guessed: the detector treats
        // `null` as "nobody is due in", which lowers the severity rather than
        // raising it.
        nextArrivalAt: null,
      }
    })
  }

  /* ── laundry ───────────────────────────────────────────────────────── */

  /**
   * Open orders in the window.
   *
   * `confirmedAt` is ALWAYS null, and that is a statement about the schema
   * rather than about the provider: `laundry_orders` has `sent_at` and
   * `expected_return_at` and no column anywhere for the provider's reply. So an
   * `external` operation sees `laundry.unconfirmed` on every open order, which
   * is literally true — nobody has recorded a confirmation — and is noise until
   * the column exists. Reported rather than papered over with `sent_at`, which
   * would record our own message as their agreement.
   */
  async loadLaundry(scope: FactScope): Promise<readonly LaundryFacts[]> {
    let query = this.db
      .from('laundry_orders')
      .select(
        'id, property_id, status, required_by, expected_return_at, ' +
          'provider_id',
      )
      .eq('organization_id', scope.organizationId)
      .lt('required_by', scope.to.toISOString())
      .order('required_by', { ascending: true })
      .limit(scope.pageSize)

    if (scope.propertyId !== null) {
      // A consolidated order carries `property_id` NULL and must not vanish
      // when somebody narrows to one of the properties in it.
      query = query.or(`property_id.is.null,property_id.eq.${scope.propertyId}`)
    }

    const [{ data, error }, names, providers] = await Promise.all([
      query,
      this.propertyNames(scope.organizationId),
      this.providerNames(scope.organizationId),
    ])
    if (error) throw error

    return toRows(data ?? []).map((row) => {
      const propertyId = asStringOrNull(row, 'property_id')
      const providerId = asStringOrNull(row, 'provider_id')
      return {
        orderId: asString(row, 'id'),
        propertyId,
        label: names.get(propertyId ?? '') ?? 'כביסה מרוכזת',
        bookingId: null,
        status: asEnum(row, 'status', LAUNDRY_STATUSES),
        requiredBy: asTimestampOrNull(row, 'required_by'),
        confirmedAt: null,
        expectedBackAt: asTimestampOrNull(row, 'expected_return_at'),
        providerName:
          providerId === null ? null : (providers.get(providerId) ?? null),
      }
    })
  }

  private async providerNames(
    organizationId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const { data, error } = await this.db
      .from('laundry_providers')
      .select('id, name')
      .eq('organization_id', organizationId)

    if (error) throw error
    return new Map(
      toRows(data ?? []).map((row) => [
        asString(row, 'id'),
        asString(row, 'name'),
      ]),
    )
  }

  /* ── preparation ───────────────────────────────────────────────────── */

  /**
   * The changeovers in the window, and what the plan says about each.
   *
   * `planPublished` mirrors `planGenerated` because there is no publish step in
   * the model: `work_plans` has no status column and a built plan is already
   * readable by the people doing the work. That is the same finding that keeps
   * `preparation.publishWorkPlan` deliberately unbound in `execute/registry.ts`,
   * and reporting a plan as unpublished would raise a signal about a state the
   * product does not have.
   *
   * `percentComplete` and `startedAt` stay null: completion lives inside the
   * `sections` jsonb whose shape belongs to `preparation/work-plan.ts`, and
   * re-reading it here would be a second answer to how far along the work is.
   */
  async loadPreparation(
    scope: FactScope,
  ): Promise<readonly PreparationFacts[]> {
    const bookings = await this.bookingsArriving(scope)
    if (bookings.length === 0) return []

    const { data, error } = await this.db
      .from('work_plans')
      .select('booking_id, critical_path_minutes')
      .eq('organization_id', scope.organizationId)
      .in(
        'booking_id',
        bookings.map((booking) => booking.id),
      )

    if (error) throw error

    const plans = new Map(
      toRows(data ?? []).map((row) => [
        asString(row, 'booking_id'),
        asNumberOrNull(row, 'critical_path_minutes'),
      ]),
    )

    return bookings.map((booking) => {
      const planned = plans.has(booking.id)
      return {
        bookingId: booking.id,
        propertyId: booking.propertyId,
        label: booking.label,
        planGenerated: planned,
        planPublished: planned,
        percentComplete: null,
        typicalMinutes: planned ? (plans.get(booking.id) ?? null) : null,
        arrivalAt: booking.arrivalAt,
        startedAt: null,
        additionalItems: [],
      }
    })
  }

  /* ── contracts ─────────────────────────────────────────────────────── */

  /**
   * Whether each arriving booking's contract is signed, and whether it was
   * ever put in front of the guest.
   *
   * `sentAt` is the most recent `guest_link_sends` row, because the contract is
   * presented inside the guest journey and there is no separate record of a
   * contract being sent. That is stated rather than hidden: it makes "the
   * contract was not sent" mean "the guest has never been sent their link",
   * which is the true and useful reading — a guest who never got the link
   * cannot have signed anything.
   */
  async loadContracts(scope: FactScope): Promise<readonly ContractFacts[]> {
    const journey = await this.guestJourney(scope.organizationId)
    const required = journey !== null && journey.contractMode !== 'disabled'

    const bookings = await this.bookingsArriving(scope)
    if (bookings.length === 0) return []

    const ids = bookings.map((booking) => booking.id)

    const [signatures, sends] = await Promise.all([
      this.db
        .from('booking_contract_signatures')
        .select('booking_id, signed_at')
        .eq('organization_id', scope.organizationId)
        .in('booking_id', ids),
      this.db
        .from('guest_link_sends')
        .select('booking_id, sent_at')
        .eq('organization_id', scope.organizationId)
        .in('booking_id', ids)
        .order('sent_at', { ascending: false }),
    ])
    if (signatures.error) throw signatures.error
    if (sends.error) throw sends.error

    const signed = new Map<string, string>()
    for (const row of toRows(signatures.data ?? [])) {
      const at = asTimestampOrNull(row, 'signed_at')
      if (at !== null) signed.set(asString(row, 'booking_id'), at)
    }

    const sent = new Map<string, string>()
    for (const row of toRows(sends.data ?? [])) {
      const bookingId = asString(row, 'booking_id')
      // Ordered newest first, so the first one wins and the rest are earlier
      // sends of the same link.
      if (sent.has(bookingId)) continue
      const at = asTimestampOrNull(row, 'sent_at')
      if (at !== null) sent.set(bookingId, at)
    }

    return bookings.map((booking) => ({
      bookingId: booking.id,
      propertyId: booking.propertyId,
      label: booking.label,
      required,
      sentAt: sent.get(booking.id) ?? null,
      signedAt: signed.get(booking.id) ?? null,
      arrivalAt: booking.arrivalAt,
    }))
  }

  /* ── the four with no source ───────────────────────────────────────── */

  async loadPayments(): Promise<readonly PaymentFacts[] | null> {
    return null
  }

  async loadShortages(): Promise<readonly ShortageFacts[] | null> {
    return null
  }

  async loadAccess(): Promise<readonly AccessFacts[] | null> {
    return null
  }

  async loadEmptyNights(): Promise<readonly EmptyNightFacts[] | null> {
    return null
  }

  /* ── bookings ──────────────────────────────────────────────────────── */

  private async bookingsArriving(scope: FactScope): Promise<
    readonly {
      id: string
      propertyId: string
      label: string
      arrivalAt: string | null
    }[]
  > {
    let query = this.db
      .from('bookings')
      .select('id, property_id, reference, check_in, arrival_time, status')
      .eq('organization_id', scope.organizationId)
      .gte('check_in', scope.from.toISOString().slice(0, ISO_DAY))
      .lt('check_in', scope.to.toISOString().slice(0, ISO_DAY))
      .order('check_in', { ascending: true })
      .limit(scope.pageSize)

    if (scope.propertyId !== null) {
      query = query.eq('property_id', scope.propertyId)
    }

    const [{ data, error }, names] = await Promise.all([
      query,
      this.propertyNames(scope.organizationId),
    ])
    if (error) throw error

    return toRows(data ?? [])
      .filter((row) => !CLOSED_BOOKINGS.has(asString(row, 'status')))
      .map((row) => {
        const propertyId = asString(row, 'property_id')
        return {
          id: asString(row, 'id'),
          propertyId,
          label: `${names.get(propertyId) ?? propertyId} · ${asString(
            row,
            'reference',
          )}`,
          arrivalAt: arrivalInstant(
            asStringOrNull(row, 'check_in'),
            asStringOrNull(row, 'arrival_time'),
          ),
        }
      })
  }
}

/**
 * Statuses in which nothing is owed and nobody is arriving.
 *
 * Filtered in the application rather than in the query because the set is a
 * statement about what detection is for, and it belongs beside the reason for
 * it: a cancelled stay has no readiness and a completed one has no deadline.
 */
const CLOSED_BOOKINGS: ReadonlySet<string> = new Set([
  'cancelled',
  'no_show',
  'completed',
  'checked_out',
])
