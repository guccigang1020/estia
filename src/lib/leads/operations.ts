/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person can do to an enquiry, and to
 * two guest rows that turn out to be one person.
 *
 * Five operations, and the shape of the list is the argument:
 *
 *   record        write down an enquiry, attached to the guest it belongs to
 *   changeStatus  move it along §4.1, including closing and reopening it
 *   assign        give it an owner
 *   mergeGuests   join two guest profiles
 *   undoMerge     take that back, inside thirty days
 *
 * **There is no `deleteLead`.** `0074` refuses DELETE on the table to every
 * role, which is the same argument `0066` makes about reviews: "who enquired
 * and never got an answer" is the measurement this table exists for, and a
 * measurement that can be improved by removing rows is not one. A lead that
 * should not be worked is closed as `lost` with a reason, which is a fact
 * rather than an absence.
 *
 * **There is no `convertLeadToBooking`.** Creating a booking belongs to
 * `src/lib/booking`, and an operation here that created one would be a second
 * path into the availability engine. `changeStatus` to `booked` records the
 * link to a booking that already exists, and refuses when that booking is
 * still `inquiry`/`quote`/`option` — see `transitions.ts` for why the demand
 * list is imported rather than restated.
 *
 * ── Why the merges go through the database ────────────────────────────────
 *
 * `mergeGuests` and `undoMerge` call `public.guest_merge_apply` and
 * `public.guest_merge_undo` rather than writing rows. The header of
 * `0074_leads_and_guest_merges.sql` sets out the reason at length: the person
 * merging holds `guest.update` and `guest.delete` and need not hold
 * `booking.update` or `review.manage`, so moving a booking's `guest_id` under
 * their own row level security would fail for exactly the people who are
 * supposed to be doing this — and the alternative, a service-role client in
 * the request path, puts a credential that bypasses every policy into a
 * screen.
 *
 * That does not make this layer decorative. The pipeline still runs authorize
 * → validate → rule → transaction → **audit** → event around the call, and the
 * audit event is the one this module is responsible for: `guest_merges` says
 * what was done, and the audit row says who did it in a sentence a person
 * reads.
 */

import { assertCan } from '../authz/can'
import { BusinessRuleError } from '../errors'
import { clientFor, recordWrite, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { asMergeFailure } from './errors'
import {
  MERGE_REASON_MIN,
  problemsWithMerge,
  sanitiseChoices,
  type MergeChoices,
} from './merge'
import { problemsWith } from './transitions'
import {
  LEAD_LOST_REASONS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  LEAD_STATUS_LABEL,
  type LeadLostReason,
  type LeadStatus,
} from './types'
import type { BookingStatusName } from '../revenue/types'

const LEADS = 'leads'

/* ---------------------------------------------------------------- input -- */

const RECORD_INPUT = s.object({
  source: s.enumOf(LEAD_SOURCES, { label: 'מקור הפנייה' }),
  sourceDetail: s.nullable(s.string({ label: 'פירוט המקור', max: 200 })),
  propertyId: s.nullable(s.uuid({ label: 'נכס' })),
  // AS TYPED, and that is why the maximum is generous and the minimum is one.
  // Trimming a name into shape here would destroy the only evidence of what
  // the person actually wrote.
  rawName: s.nullable(s.string({ label: 'שם', min: 1, max: 200 })),
  rawPhone: s.nullable(s.string({ label: 'טלפון', min: 1, max: 40 })),
  rawEmail: s.nullable(s.string({ label: 'אימייל', min: 3, max: 254 })),
  requestedCheckIn: s.nullable(s.string({ label: 'תאריך כניסה', max: 10 })),
  requestedCheckOut: s.nullable(s.string({ label: 'תאריך יציאה', max: 10 })),
  partyAdults: s.number({ label: 'מבוגרים', min: 1, max: 60, integer: true }),
  partyChildren: s.number({ label: 'ילדים', min: 0, max: 60, integer: true }),
  partyInfants: s.number({ label: 'תינוקות', min: 0, max: 60, integer: true }),
  budgetAgorot: s.nullable(s.agorot({ label: 'תקציב' })),
  message: s.nullable(s.string({ label: 'מה נכתב', max: 4000 })),
})

export interface LeadDraft {
  source: (typeof LEAD_SOURCES)[number]
  sourceDetail: string | null
  propertyId: string | null
  rawName: string | null
  rawPhone: string | null
  rawEmail: string | null
  requestedCheckIn: string | null
  requestedCheckOut: string | null
  partyAdults: number
  partyChildren: number
  partyInfants: number
  budgetAgorot: number | null
  message: string | null
}

const STATUS_INPUT = s.object({
  leadId: s.uuid({ label: 'ליד' }),
  status: s.enumOf(LEAD_STATUSES, { label: 'מצב' }),
  lostReason: s.nullable(s.enumOf(LEAD_LOST_REASONS, { label: 'סיבת סגירה' })),
  lostNote: s.nullable(s.string({ label: 'פירוט', max: 1000 })),
  bookingId: s.nullable(s.uuid({ label: 'הזמנה' })),
  /** Required when reopening, and carried into the audit row either way. */
  note: s.nullable(s.string({ label: 'נימוק', max: 1000 })),
})

export interface StatusChange {
  leadId: string
  status: LeadStatus
  lostReason: LeadLostReason | null
  lostNote: string | null
  bookingId: string | null
  note: string | null
}

const ASSIGN_INPUT = s.object({
  leadId: s.uuid({ label: 'ליד' }),
  assignedToUserId: s.nullable(s.uuid({ label: 'אחראי' })),
  /** "What is the next step, and when." §4.1 makes it mandatory at `interested`. */
  nextActionAt: s.nullable(s.isoDateTime({ label: 'מועד הטיפול הבא' })),
})

export interface Assignment {
  leadId: string
  assignedToUserId: string | null
  nextActionAt: Date | null
}

const MERGE_INPUT = s.object({
  survivorGuestId: s.uuid({ label: 'הפרופיל שיישאר' }),
  mergedGuestId: s.uuid({ label: 'הפרופיל שימוזג' }),
  survivorVersion: s.number({ label: 'גרסה', min: 1, integer: true }),
  mergedVersion: s.number({ label: 'גרסה', min: 1, integer: true }),
  /** §5.3 · a name typed, not a button pressed. */
  typedSurvivorName: s.string({ label: 'שם האורח השורד', min: 1, max: 200 }),
  choices: s.object(
    {
      full_name: s.optional(s.enumOf(['survivor', 'merged'] as const)),
      first_name: s.optional(s.enumOf(['survivor', 'merged'] as const)),
      last_name: s.optional(s.enumOf(['survivor', 'merged'] as const)),
      email: s.optional(s.enumOf(['survivor', 'merged'] as const)),
      phone: s.optional(s.enumOf(['survivor', 'merged'] as const)),
      phone_alt: s.optional(s.enumOf(['survivor', 'merged'] as const)),
      language: s.optional(s.enumOf(['survivor', 'merged'] as const)),
    },
    { label: 'הכרעות' },
  ),
})

export interface MergeInput {
  survivorGuestId: string
  mergedGuestId: string
  survivorVersion: number
  mergedVersion: number
  typedSurvivorName: string
  choices: MergeChoices
}

const UNDO_INPUT = s.object({ mergeId: s.uuid({ label: 'מיזוג' }) })

/* -------------------------------------------------------- what it needs -- */

/** The guest row a merge screen was built from, for the confirmation check. */
export interface MergeTargets {
  survivorName: string
  survivorVersion: number
  mergedVersion: number
}

export interface LeadOperations {
  record: Operation<LeadDraft, null, { id: string; guestId: string | null }>
  changeStatus: Operation<StatusChange, LeadSnapshot, { id: string }>
  assign: Operation<Assignment, LeadSnapshot, { id: string }>
  mergeGuests: Operation<MergeInput, MergeTargets, { mergeId: string }>
  undoMerge: Operation<{ mergeId: string }, null, { mergeId: string }>
}

/** Just enough of a lead to decide a transition and write a sentence. */
export interface LeadSnapshot {
  id: string
  propertyId: string | null
  status: LeadStatus
  version: number
  displayName: string
  assignedToUserId: string | null
  createdByUserId: string | null
  firstResponseAt: string | null
}

export function defineLeadOperations(options: {
  db: Db
  /** Reads one lead, scoped to the organization, or null. */
  loadLead: (
    organizationId: string,
    leadId: string,
  ) => Promise<LeadSnapshot | null>
  /**
   * The guest a new lead attaches to, decided by `attachmentFor` against rows
   * the caller queried. Returns null when nothing matched — which is a real
   * answer and not a failure (ח40-08).
   */
  resolveGuest: (
    organizationId: string,
    lead: { rawPhone: string | null; rawEmail: string | null },
  ) => Promise<string | null>
  /** The linked booking's status, for the "did it actually convert" test. */
  loadBookingStatus: (
    organizationId: string,
    bookingId: string,
  ) => Promise<BookingStatusName | null>
  /** The two guest rows a merge screen was built from. */
  loadMergeTargets: (
    organizationId: string,
    survivorId: string,
    mergedId: string,
  ) => Promise<MergeTargets | null>
}): LeadOperations {
  /* --------------------------------------------------------- recording -- */

  const record = defineOperation<
    LeadDraft,
    null,
    { id: string; guestId: string | null }
  >({
    name: 'lead.record',
    permission: 'lead.create',
    resourceType: 'lead',
    input: RECORD_INPUT,

    /**
     * Scope, asserted by hand because there is nothing to load.
     *
     * The pipeline checks tenant and scope against a loaded resource and a
     * creation has none. Without this an agent narrowed to two properties
     * would reach the insert for a third. `family: 'booking'` is what a lead
     * belongs to — `RESOURCE_FAMILIES` says so in as many words, "bookings,
     * holds, quotes, leads" — so an external seller narrowed to their own
     * records is narrowed here too.
     */
    rule({ input, context }) {
      assertCan(context.actor, 'lead.create', {
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId ?? undefined,
        family: 'booking',
      })

      // ח40-20, said in Hebrew before the constraint says it in SQL. The
      // constraint is written against the normalised forms, so " - " in the
      // telephone box is refused there; this catches the plain case early.
      if (blank(input.rawPhone) && blank(input.rawEmail)) {
        throw new BusinessRuleError({
          code: 'lead.no_way_to_answer',
          message: 'a lead needs a phone or an email',
          userMessage:
            'צריך טלפון או מייל כדי לחזור לפונה. פנייה שאי אפשר להשיב לה ' +
            'אינה ליד.',
        })
      }

      if (
        input.requestedCheckIn !== null &&
        input.requestedCheckOut !== null &&
        input.requestedCheckOut <= input.requestedCheckIn
      ) {
        throw new BusinessRuleError({
          code: 'lead.dates_out_of_order',
          message: 'requested_check_out must be after requested_check_in',
          userMessage: 'תאריך היציאה חייב להיות אחרי תאריך הכניסה.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      // ח40-08 · attach or leave null. NEVER create a second guest card: that
      // is the failure §17 opens with, and it is the one this whole module is
      // downstream of.
      const guestId = await options.resolveGuest(context.actor.organizationId, {
        rawPhone: input.rawPhone,
        rawEmail: input.rawEmail,
      })

      const { data, error } = await db
        .from(LEADS)
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId,
          guest_id: guestId,
          source: input.source,
          source_detail: input.sourceDetail,
          // `phone_e164` and `email_normalized` are generated columns and are
          // deliberately never written, exactly as `guests.phone_e164` never
          // is: a write path that can supply the deduplication key is a write
          // path that can get it wrong.
          raw_name: input.rawName,
          raw_phone: input.rawPhone,
          raw_email: input.rawEmail,
          requested_check_in: input.requestedCheckIn,
          requested_check_out: input.requestedCheckOut,
          party_adults: input.partyAdults,
          party_children: input.partyChildren,
          party_infants: input.partyInfants,
          budget_agorot: input.budgetAgorot,
          message: input.message,
        })
        .select('id')
        .single()

      if (error) throw error
      if (!data) {
        throw new BusinessRuleError({
          code: 'lead.not_readable',
          message:
            'leads insert returned no row; leads_select refused the read',
          userMessage:
            'הפנייה נשמרה אך אינה פתוחה לצפייה בהרשאות שלך. נדרשת הרשאת ' +
            'צפייה בלידים כדי לראות אותה.',
        })
      }

      recordWrite(tx, 'leads.insert')
      return { id: String((data as { id: string }).id), guestId }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        propertyId: input.propertyId,
        // The name and the source. NOT the telephone number: an audit summary
        // containing one is a telephone number in every export of that
        // timeline, and the lead row itself holds it behind guest.view_phone.
        summary:
          `נרשמה פנייה חדשה מ${input.source} — ` +
          `${input.rawName ?? 'ללא שם'}` +
          (result.guestId === null
            ? ' · לא זוהתה התאמה לאורח קיים'
            : ' · הוצמדה לאורח קיים לפי מספר הטלפון'),
        after: {
          source: input.source,
          hasPhone: !blank(input.rawPhone),
          hasEmail: !blank(input.rawEmail),
          attachedToGuest: result.guestId !== null,
          propertyId: input.propertyId,
        },
      }
    },

    events({ result }) {
      return [{ name: 'lead.created', payload: { leadId: result.id } }]
    },
  })

  /* ------------------------------------------------------ moving it on -- */

  const loadLeadResource = async ({
    input,
    context,
  }: {
    input: { leadId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const lead = await options.loadLead(
      context.actor.organizationId,
      input.leadId,
    )
    if (lead === null) return null
    return {
      resource: {
        organizationId: context.actor.organizationId,
        propertyId: lead.propertyId ?? undefined,
        assignedToUserId: lead.assignedToUserId ?? undefined,
        createdByUserId: lead.createdByUserId ?? undefined,
        family: 'booking' as const,
      },
      entity: lead,
      version: lead.version,
    }
  }

  const changeStatus = defineOperation<
    StatusChange,
    LeadSnapshot,
    { id: string }
  >({
    name: 'lead.change_status',
    permission: 'lead.update',
    resourceType: 'lead',
    input: STATUS_INPUT,
    loadResource: loadLeadResource,

    async rule({ input, entity, context }) {
      const bookingStatus =
        input.bookingId === null
          ? null
          : await options.loadBookingStatus(
              context.actor.organizationId,
              input.bookingId,
            )

      const problems = problemsWith({
        from: entity.status,
        to: input.status,
        lostReason: input.lostReason,
        lostNote: input.lostNote,
        bookingId: input.bookingId,
        bookingStatus,
        reason: input.note ?? context.reason ?? null,
      })

      if (problems.length > 0) {
        throw new BusinessRuleError({
          code: 'lead.transition_refused',
          message: problems.map((problem) => problem.message).join(' '),
          userMessage: problems.map((problem) => problem.message).join(' '),
          publicDetails: { problems: problems.map((p) => p.field) },
        })
      }
    },

    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)

      // ח40-22 · written only when it is still empty. The trigger restores
      // it regardless, so this is the polite half of a rule the database
      // enforces; sending it every time would just be sending something
      // about to be ignored.
      const firstResponse =
        entity.firstResponseAt === null && input.status !== 'lost'
          ? { first_response_at: now.toISOString() }
          : {}

      const { error } = await db
        .from(LEADS)
        .update({
          status: input.status,
          // Cleared on the way out of `lost` by the trigger as well; sent
          // here so the row is right even if somebody reads it inside the
          // same transaction.
          lost_reason: input.status === 'lost' ? input.lostReason : null,
          lost_note: input.status === 'lost' ? input.lostNote : null,
          booking_id: input.bookingId ?? undefined,
          ...firstResponse,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.leadId)

      if (error) throw error
      recordWrite(tx, 'leads.update')
      return { id: input.leadId }
    },

    audit({ input, entity, context }) {
      const from = LEAD_STATUS_LABEL[entity.status]
      const to = LEAD_STATUS_LABEL[input.status]
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        summary:
          `${context.auditActor.label} העבירה את הפנייה של ` +
          `${entity.displayName} מ״${from}״ ל״${to}״` +
          (input.status === 'lost' && input.lostReason !== null
            ? ` · סיבה: ${input.lostReason}`
            : ''),
        before: { status: entity.status },
        after: {
          status: input.status,
          lostReason: input.lostReason,
          bookingId: input.bookingId,
        },
        reason: input.note ?? undefined,
      }
    },

    events({ input, entity }) {
      return [
        {
          name: 'lead.status_changed',
          propertyId: entity.propertyId,
          payload: {
            leadId: entity.id,
            from: entity.status,
            to: input.status,
          },
        },
      ]
    },
  })

  /* --------------------------------------------------------- assigning -- */

  const assign = defineOperation<Assignment, LeadSnapshot, { id: string }>({
    name: 'lead.assign',
    permission: 'lead.assign',
    resourceType: 'lead',
    input: ASSIGN_INPUT,
    loadResource: loadLeadResource,

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from(LEADS)
        .update({
          assigned_to_user_id: input.assignedToUserId,
          next_action_at: input.nextActionAt?.toISOString() ?? null,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.leadId)

      if (error) throw error
      recordWrite(tx, 'leads.update')
      return { id: input.leadId }
    },

    audit({ input, entity, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        summary:
          input.assignedToUserId === null
            ? `${context.auditActor.label} הסירה את האחראי מהפנייה של ${entity.displayName}`
            : `${context.auditActor.label} שייכה את הפנייה של ${entity.displayName} לטיפול`,
        before: { assignedToUserId: entity.assignedToUserId },
        after: {
          assignedToUserId: input.assignedToUserId,
          nextActionAt: input.nextActionAt?.toISOString() ?? null,
        },
      }
    },
  })

  /* ----------------------------------------------------------- merging -- */

  const mergeGuests = defineOperation<
    MergeInput,
    MergeTargets,
    { mergeId: string }
  >({
    name: 'guest.merge',
    // ח40-19 · `guest.merge` is not in the catalogue. Until it is, a merge
    // needs both halves of what it actually does, and it is treated as a
    // sensitive action — hence `requiresReason` below rather than relying on
    // `SENSITIVE_ACTIONS`, which does not carry `guest.update`.
    permission: 'guest.update',
    resourceType: 'guest',
    input: MERGE_INPUT,
    requiresReason: true,

    async loadResource({ input, context }) {
      const targets = await options.loadMergeTargets(
        context.actor.organizationId,
        input.survivorGuestId,
        input.mergedGuestId,
      )
      if (targets === null) return null
      return {
        resource: {
          organizationId: context.actor.organizationId,
          family: 'guest' as const,
        },
        entity: targets,
      }
    },

    rule({ input, entity, context }) {
      // The second half of ח40-19. `assertCan` and not a boolean check: the
      // refusal it raises is the same one every other denial in the product
      // raises, with the same shape and the same Hebrew.
      assertCan(context.actor, 'guest.delete', {
        organizationId: context.actor.organizationId,
        family: 'guest',
      })

      const problems = problemsWithMerge({
        survivorId: input.survivorGuestId,
        mergedId: input.mergedGuestId,
        reason: context.reason ?? '',
        typedSurvivorName: input.typedSurvivorName,
        survivorName: entity.survivorName,
      })

      if (problems.length > 0) {
        throw new BusinessRuleError({
          code: 'guest_merge.refused',
          message: problems.map((problem) => problem.message).join(' '),
          userMessage: problems.map((problem) => problem.message).join(' '),
          publicDetails: { fields: problems.map((problem) => problem.field) },
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      // Everything the function needs, and nothing it does not: the choices
      // are stripped of any field the database decides by rule, so a caller
      // sending `marketing_consent: 'merged'` sees it dropped here rather than
      // silently ignored one layer down.
      const { data, error } = await db.rpc('guest_merge_apply', {
        p_organization_id: context.actor.organizationId,
        p_survivor_guest_id: input.survivorGuestId,
        p_merged_guest_id: input.mergedGuestId,
        p_survivor_version: input.survivorVersion,
        p_merged_version: input.mergedVersion,
        p_field_choices: sanitiseChoices(
          input.choices as unknown as Record<string, unknown>,
        ),
        p_reason: context.reason ?? '',
      })

      const failure = asMergeFailure(error)
      if (failure) throw failure
      if (error) throw error

      recordWrite(tx, 'guests.merge')
      return { mergeId: String(data) }
    },

    audit({ input, entity, result, context }) {
      return {
        resourceId: input.survivorGuestId,
        // §14's sentence, minus anything on NEVER_LOGGED. No telephone number
        // and no document number — the merge record itself carries what moved,
        // and this says who decided and which profile survived.
        summary:
          `${context.auditActor.label} מיזגה שני פרופילים לתוך ` +
          `${entity.survivorName}`,
        before: {
          survivorGuestId: input.survivorGuestId,
          mergedGuestId: input.mergedGuestId,
        },
        after: { mergeId: result.mergeId },
      }
    },

    events({ input, result }) {
      return [
        {
          name: 'guest.merged',
          payload: {
            mergeId: result.mergeId,
            survivorGuestId: input.survivorGuestId,
            mergedGuestId: input.mergedGuestId,
          },
        },
      ]
    },
  })

  /* ---------------------------------------------------------- undoing -- */

  const undoMerge = defineOperation<
    { mergeId: string },
    null,
    { mergeId: string }
  >({
    name: 'guest.merge_undo',
    permission: 'guest.update',
    resourceType: 'guest',
    input: UNDO_INPUT,
    requiresReason: true,

    rule({ context }) {
      assertCan(context.actor, 'guest.delete', {
        organizationId: context.actor.organizationId,
        family: 'guest',
      })

      if ((context.reason ?? '').trim().length < MERGE_REASON_MIN) {
        throw new BusinessRuleError({
          code: 'guest_merge.undo_reason_required',
          message: 'undo reason too short',
          userMessage: 'ביטול מיזוג דורש נימוק — לפחות משפט קצר.',
        })
      }
    },

    async execute({ input, tx, context }) {
      const db = clientFor(tx, options.db)

      const { error } = await db.rpc('guest_merge_undo', {
        p_merge_id: input.mergeId,
        p_reason: context.reason ?? '',
      })

      const failure = asMergeFailure(error)
      if (failure) throw failure
      if (error) throw error

      recordWrite(tx, 'guests.merge_undo')
      return { mergeId: input.mergeId }
    },

    audit({ input, context }) {
      return {
        resourceId: input.mergeId,
        summary: `${context.auditActor.label} ביטלה מיזוג של שני פרופילי אורח`,
        after: { mergeId: input.mergeId, undone: true },
      }
    },

    // No domain event. `src/lib/contracts/events.ts` has `guest.merged` and no
    // name for undoing one, and emitting `guest.merged` again would tell every
    // subscriber the opposite of what happened. The audit row and
    // `guest_merges.undone_at` are the record until a name exists.
  })

  return { record, changeStatus, assign, mergeGuests, undoMerge }
}

function blank(value: string | null): boolean {
  return value === null || value.trim().length === 0
}
