'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What the preparation policy screen does.
 *
 * Two actions and no third. One computes what a configuration *would* produce
 * and writes nothing; the other stores it, through the operation that carries
 * authorization, validation, the domain rule, the transaction, the audit event
 * and idempotency. There is no `db.from('preparation_catalogues').update(…)`
 * anywhere on this screen, because that call would look identical in the
 * browser and would skip all six.
 *
 * ── Why the preview is a Server Action and not a hook ─────────────────────
 *
 * The preview has to be **the engine**, not a second implementation of it —
 * a preview that agrees on the easy cases and disagrees on the interesting
 * ones is worse than none. `previewPlan` freezes a snapshot and runs the same
 * `assemblePlan` that `buildPlan` runs, and `captureSnapshot` hashes through
 * `fingerprint` in the service layer. Running that in the browser would mean
 * shipping the costing engine, the snapshot machinery and the service layer
 * into a client bundle so that a settings screen could show a number. A round
 * trip on an explicit button is the cheaper honesty.
 *
 * ── The preview needs no stored policy ────────────────────────────────────
 *
 * It is computed from the draft in the form, so it answers before anything has
 * ever been saved — which is the only order in which a person can decide
 * whether the policy they are writing is right. It is also why the preview
 * takes the whole draft rather than a property id.
 *
 * ── Both actions refuse independently ─────────────────────────────────────
 *
 * A Server Action is a POST and is reachable without the screen that rendered
 * the form. `assertCan` runs here before anything is read, the operation's
 * pipeline checks the same permission again against the loaded property, and
 * row level security refuses regardless — `preparation_catalogues_update`
 * demands `checklist.manage` in the database as well.
 */

import { revalidatePath } from 'next/cache'

import { assertCan, redact, type Resource } from '@/lib/authz/can'
import { addDays, localDate } from '@/lib/booking/dates'
import {
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import {
  catalogueFrom,
  catalogueProblems,
  configureInput,
  previewPlan,
  type ConfigureInput,
  type PlanSectionKey,
  type PreparationBooking,
  type RequirementCategory,
  type RequirementUnit,
} from '@/lib/preparation'

import { shellContext } from '../../_lib/context'
import type { PreviewParty } from './policy'
import { auditActorFor, catalogueWiring } from './wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/* ------------------------------------------------------------- the gate -- */

async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: refusal(
        'unauthenticated',
        'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
      ),
    }
  }

  if (context.status !== 'ready') {
    return {
      ok: false as const,
      error: refusal(
        'membership_not_active',
        'אין לך מרחב עבודה פעיל, ולכן לא ניתן לערוך מדיניות הכנה.',
        'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
      ),
    }
  }

  return { ok: true as const, context }
}

function refusal(
  code: string,
  message: string,
  retryMessage: string,
): SafeErrorBody {
  return {
    code,
    message,
    dataMessage: 'שום דבר לא נשמר. המדיניות הקיימת לא השתנתה.',
    retryMessage,
    dataOutcome: 'not_saved',
    retryable: false,
    correlationId: crypto.randomUUID(),
  }
}

function failure(
  cause: unknown,
  correlationId: string,
): { ok: false; error: SafeErrorBody } {
  return { ok: false, error: toSafeResponse(cause, correlationId).error }
}

/**
 * The draft, validated by the same schema the operation validates.
 *
 * Called by the preview as well as by the save. A preview computed from an
 * unvalidated payload would happily divide by a string and print `NaN`
 * pillows, and a person would reasonably read that as the engine being broken
 * rather than their form being empty.
 */
function validated(draft: unknown): ConfigureInput {
  const result = configureInput.validate(draft, '')
  if (result.ok) return result.value

  // Every offending field, not the first: the editor renders one long form and
  // a person told about one bad number at a time gives up before the third.
  throw new ValidationError(result.issues, {
    message: 'The submitted preparation policy failed schema validation',
  })
}

/* ------------------------------------------------------------ the preview -- */

export type PreviewItem = {
  itemId: string
  label: string
  category: RequirementCategory
  unit: RequirementUnit
  requiredCount: number
  requiresPhoto: boolean
  instructions: string | null
  minutes: number
}

export type PreviewSection = {
  key: PlanSectionKey
  label: string
  minutes: number
  items: readonly PreviewItem[]
}

export type PreviewBedLine = {
  bedTypeId: string
  label: string
  source: 'permanent' | 'storage' | 'added'
  count: number
  capacity: number
}

/**
 * What the screen renders. Every figure is read off the real plan.
 *
 * `labourCost` is the one field with a grant on it, and it is removed by
 * `redact()` rather than by the component choosing not to show it: the rate it
 * is computed from is stored on the catalogue, a housekeeping supervisor holds
 * `checklist.manage` and does not hold `report.financial.view`, and a field
 * that reaches the browser is a field that reached the browser whatever the
 * markup does with it.
 */
export type PolicyPreview = {
  guests: number
  sleepingPlaces: number
  permanentCapacity: number
  extraBeds: number
  unplacedGuests: number
  beds: readonly PreviewBedLine[]
  sections: readonly PreviewSection[]
  criticalPathMinutes: number
  recommendedStaff: number
  estimatedMinutes: number
  complexityScore: number
  /** The ruleset the plan was frozen against. Two identical policies share it. */
  snapshotHash: string
  /** Present only for a reader who may see money. */
  labourCost?: number
  /** What the configuration cannot do, said before it is saved. */
  problems: readonly string[]
}

/**
 * The party, as a booking the engine will accept.
 *
 * Hypothetical in existence and real in shape: it carries no id that points at
 * anything, no price lines — the preview is not a costing — and a stay that
 * starts today, because the effective dating in `captureSnapshot` resolves
 * against the arrival date and a preview of a policy is a question about
 * today's rules.
 */
function previewBooking(
  party: PreviewParty,
  draft: ConfigureInput,
  organizationId: string,
): PreparationBooking {
  const checkIn = localDate(new Date())
  const nights = Math.max(1, Math.round(party.nights))

  return {
    id: crypto.randomUUID(),
    organizationId,
    propertyId: draft.propertyId,
    unitId: draft.propertyId,
    stay: { checkIn, checkOut: addDays(checkIn, nights) },
    guests: party.guests,
    adults: party.adults,
    children: party.children,
    eventType: party.eventType,
    extras: [],
    arrivalAt: `${checkIn}T00:00:00.000Z`,
    priceLines: [],
  }
}

export async function previewPolicyAction(input: {
  draft: unknown
  party: PreviewParty
}): Promise<ActionResult<PolicyPreview>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const draft = validated(input.draft)

    const resource: Resource = {
      organizationId: context.actor.organizationId,
      propertyId: draft.propertyId,
      family: 'operations',
    }
    assertCan(context.actor, 'checklist.manage', resource)

    const catalogue = catalogueFrom({
      wire: draft,
      organizationId: context.actor.organizationId,
      // The draft on its own, deliberately. A preview that quietly merged the
      // stored cost model in would show a plan the submitted policy does not
      // produce, and the difference would only surface after saving.
      stored: null,
      today: localDate(new Date()),
    })

    const now = new Date()
    const { plan, allocation, staffing, snapshot } = previewPlan({
      catalogue,
      booking: previewBooking(input.party, draft, context.actor.organizationId),
      capturedAt: now.toISOString(),
      planId: crypto.randomUUID(),
    })

    const preview: PolicyPreview = {
      guests: allocation.guests,
      sleepingPlaces: allocation.sleepingPlaces,
      permanentCapacity: allocation.permanentCapacity,
      extraBeds: allocation.extraBeds,
      unplacedGuests: allocation.unplacedGuests,
      beds: allocation.lines.map((line) => ({
        bedTypeId: line.bedTypeId,
        label: line.label,
        source: line.source,
        count: line.count,
        capacity: line.capacity,
      })),
      sections: plan.sections.map((section) => ({
        key: section.key,
        label: section.label,
        minutes: section.minutes,
        items: section.items.map((item) => ({
          itemId: item.itemId,
          label: item.label,
          category: item.category,
          unit: item.unit,
          requiredCount: item.requiredCount,
          requiresPhoto: item.requiresPhoto,
          instructions: item.instructions,
          minutes: item.minutes,
        })),
      })),
      criticalPathMinutes: plan.criticalPathMinutes,
      recommendedStaff: plan.recommendedStaff,
      estimatedMinutes: staffing.estimatedMinutes,
      complexityScore: staffing.score,
      snapshotHash: snapshot.hash,
      labourCost: staffing.labourCost,
      problems: catalogueProblems(catalogue),
    }

    return {
      ok: true,
      data: redact(context.actor, preview, [
        { key: 'labourCost', requires: 'report.financial.view' },
      ]),
    }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/* --------------------------------------------------------------- the save -- */

export type SavedPolicy = {
  propertyId: string
  created: boolean
  bedTypes: number
  rules: number
  eventTemplates: number
  version: number
}

export async function savePolicyAction(input: {
  draft: unknown
  /**
   * The revision the form was opened on, or `null` for a property with no
   * catalogue. Sent so a second person's edit is reported as a conflict rather
   * than overwritten — the form holds a whole document, and losing somebody's
   * work silently is the failure whole-document writes are prone to.
   */
  expectedVersion: number | null
  idempotencyKey: string
}): Promise<ActionResult<SavedPolicy>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const draft = validated(input.draft)

    assertCan(context.actor, 'checklist.manage', {
      organizationId: context.actor.organizationId,
      propertyId: draft.propertyId,
      family: 'operations',
    })

    const { operations, services } = await catalogueWiring()

    const outcome = await operations.configureProperty.run({
      request: {
        idempotencyKey: input.idempotencyKey,
        resourceId: draft.propertyId,
        // Omitted rather than sent as `undefined`: the pipeline compares
        // `expectedVersion` against the loaded version only when the key is
        // present, and a first save has no revision to name.
        ...(input.expectedVersion === null
          ? {}
          : { expectedVersion: input.expectedVersion }),
        input: draft,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/preparation/policy')
    revalidatePath('/preparation')

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}
