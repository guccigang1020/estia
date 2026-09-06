/**
 * The two agent-network acts Autopilot names, and the honest shape of each.
 *
 * `AUTOPILOT_ACTIONS` names `agents.sendReminder` and
 * `agents.publishOpportunity`; `execute/registry.ts` has resolved both to
 * `command_not_implemented` since the catalogue landed. These are those two.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NEITHER OF THESE SENDS ANYTHING, AND NEITHER PRETENDS TO.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * There is no messaging transport in this product with a credential behind it.
 * `src/lib/notifications/transport.ts` says so and ships a null implementation
 * that records `not_configured`; `messaging.sendGuestMessage` is unbound in the
 * command registry for the same reason; and the notification catalogue — which
 * IS how a domain event reaches a person — carries no entry for anything in the
 * `agent.*` family, so there is not even an in-app route to hang one on.
 *
 * So both commands stop one step short of the wire, on purpose. Each one
 * **verifies that the message would be true**, composes the exact Hebrew a
 * person then sends, and returns `delivered: false` / `published: false` in as
 * many words. That is worth having rather than `command_not_implemented`,
 * because the verification is the part a planner gets wrong:
 *
 *   · a reminder about a hold that is not that agent's, or has already expired,
 *     or belongs to an agent who was suspended last week;
 *   · an "empty night" opportunity for nights that are not empty.
 *
 * Each of those is refused here, by name, with the sentence a person can act
 * on. What is missing is a transport, and a transport is not something this
 * module may invent.
 *
 * ── Why there are no domain events ───────────────────────────────────────
 *
 * The frozen catalogue has `agent.invited`, `agent.activated`,
 * `agent.suspended` and `agent.permissions_changed` — the membership
 * lifecycle — and nothing for a reminder or an opportunity, because neither
 * has ever existed. The nearest names would each announce something that did
 * not happen: `hold.extended` about a hold nobody extended, `quote.sent` about
 * a quote that does not exist. `store.product.create` in `store/operations.ts`
 * set the precedent for this case — where the catalogue has no name, the audit
 * row is the record and nothing is fabricated. The two names this wants are
 * reported rather than added.
 */

import { assertCan, type Resource } from '../authz/can'
import { checkAvailability } from '../booking/availability'
import type { AvailabilitySource } from '../booking/availability'
import { formatRange } from '../booking/dates'
import { nightsBetween, type DateRange } from '../booking/types'
import { BusinessRuleError } from '../errors'
import { defineOperation, s, type Operation } from '../service'
import type { AgentRepository } from './repository'
import { inventoryResource, type AgentOrganizationSettings } from './types'

/* --------------------------------------------------------------- shapes -- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isoDate(label: string) {
  return s.string({
    label,
    min: 10,
    max: 10,
    pattern: ISO_DATE,
    patternMessage: 'תאריך חייב להיות בפורמט YYYY-MM-DD.',
  })
}

/**
 * One kind, deliberately.
 *
 * The action's own label is "תזכורת לסוכן" and the specification named two
 * subjects: a hold near expiry and a quote awaiting a client. Only the first
 * is here. There is no quote entity anywhere in this codebase — no table, no
 * type, no repository read — so a `quote_awaiting` reminder could verify
 * nothing at all, and a reminder about a thing nothing can find is exactly the
 * message that trains an agent to ignore the next one. Reported rather than
 * faked; the enum has room the day a quote exists.
 */
const REMINDER_KINDS = ['hold_expiring'] as const

const REMINDER_INPUT = s.object({
  agentUserId: s.string({ label: 'סוכן', min: 1, max: 64 }),
  kind: s.enumOf(REMINDER_KINDS, { label: 'סוג התזכורת' }),
  holdId: s.string({ label: 'החזקה', min: 1, max: 64 }),
  /** The hold's own expiry, as the planner read it. Verified, not trusted. */
  expiresAt: s.string({ label: 'מועד פקיעה', min: 4, max: 40 }),
  unitLabel: s.string({ label: 'שם היחידה', min: 1, max: 120 }),
})

const OPPORTUNITY_INPUT = s.object({
  unitId: s.string({ label: 'יחידה', min: 1, max: 64 }),
  unitLabel: s.string({ label: 'שם היחידה', min: 1, max: 120 }),
  propertyId: s.nullable(s.string({ label: 'נכס', min: 1, max: 64 })),
  checkIn: isoDate('תאריך הגעה'),
  checkOut: isoDate('תאריך עזיבה'),
  /** Free Hebrew the business wants on the notice. Never a price — see below. */
  note: s.nullable(s.string({ label: 'הערה', max: 300 })),
})

export type AgentReminderInput = {
  agentUserId: string
  kind: (typeof REMINDER_KINDS)[number]
  holdId: string
  expiresAt: string
  unitLabel: string
}

export type PreparedAgentReminder = {
  agentUserId: string
  kind: (typeof REMINDER_KINDS)[number]
  holdId: string
  minutesLeft: number
  /** Hebrew, ready to send. Nothing in this product sends it. */
  message: string
  /** ALWAYS false. There is no transport. */
  delivered: false
  /** ALWAYS null, for the same reason. */
  channel: null
  handoff: 'manual'
}

export type OpportunityInput = {
  unitId: string
  unitLabel: string
  propertyId: string | null
  checkIn: string
  checkOut: string
  note: string | null
}

export type PreparedOpportunity = {
  unitId: string
  checkIn: string
  checkOut: string
  nights: number
  /** Hebrew, ready to publish. Carries no price — see `priced`. */
  notice: string
  /** ALWAYS false. There is no channel to the agent network. */
  published: false
  /**
   * ALWAYS false. `price.suggest` is a separate action with its own grant
   * (`pricing.manage`) and its own entitlement, and quietly naming a number
   * here would let a business-impact action take a pricing decision nobody
   * approved. The opportunity says which nights; what they cost is a second
   * decision.
   */
  priced: false
  audience: 'agent_network'
}

export type AgentCommandDeps = {
  repo: AgentRepository
  /**
   * The calendar, as the availability engine reads it.
   *
   * Injected rather than queried, because "are these nights actually empty" is
   * the booking module's question and there must not be a second answer to it
   * living in the agent network.
   */
  availability: AvailabilitySource
}

export type AgentCommands = {
  sendReminder: Operation<
    AgentReminderInput,
    AgentOrganizationSettings,
    PreparedAgentReminder
  >
  publishOpportunity: Operation<OpportunityInput, null, PreparedOpportunity>
}

/* -------------------------------------------------------------- helpers -- */

const MINUTE_MS = 60_000

const AGENT_STATUS_LABEL: Record<AgentOrganizationSettings['status'], string> =
  {
    invited: 'הוזמן וטרם הצטרף',
    pending: 'ממתין לאישור',
    active: 'פעיל',
    suspended: 'מושהה',
    removed: 'הוסר',
  }

/** The agent's own settings row, as an authorization resource. */
function agentResource(settings: AgentOrganizationSettings): Resource {
  return {
    organizationId: settings.organizationId,
    assignedToUserId: settings.agentUserId,
    family: 'team',
  }
}

function minutesUntil(expiresAt: string, now: Date): number | null {
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return null
  return Math.ceil((at - now.getTime()) / MINUTE_MS)
}

/* ------------------------------------------------------------- the build -- */

export function defineAgentCommands(deps: AgentCommandDeps): AgentCommands {
  const { repo, availability } = deps

  /* ------------------------------------------------------- the reminder -- */

  const sendReminder = defineOperation<
    AgentReminderInput,
    AgentOrganizationSettings,
    PreparedAgentReminder
  >({
    name: 'agent.reminder.prepare',
    permission: 'agent.manage',
    resourceType: 'agent',
    input: REMINDER_INPUT,

    async loadResource({ input, context }) {
      const settings = await repo.loadSettings(
        context.actor.organizationId,
        input.agentUserId,
      )
      if (!settings) return null
      return {
        resource: agentResource(settings),
        entity: settings,
        version: settings.version,
      }
    },

    /**
     * Three checks, and every one of them is a message that would otherwise
     * have been wrong.
     *
     * The hold's ownership is read from the agent's own ledger rather than
     * taken from the input, because a planner that computed the wrong id would
     * otherwise tell one agent about another agent's deal — which is exactly
     * the commercial intelligence `availability-view.ts` refuses to hand over.
     */
    async rule({ input, entity, now }) {
      if (entity.status !== 'active') {
        throw new BusinessRuleError({
          code: 'agent_reminder.agent_not_active',
          message: `Agent ${entity.agentUserId} is ${entity.status}`,
          userMessage:
            `הסוכן אינו פעיל (${AGENT_STATUS_LABEL[entity.status]}), ולכן אין ` +
            'למי לשלוח תזכורת. אם הוא אמור לעבוד — החזירו אותו לפעילות קודם.',
          publicDetails: { status: entity.status },
        })
      }

      const ledger = await repo.loadHoldLedger(
        entity.organizationId,
        entity.agentUserId,
      )
      if (!ledger.some((row) => row.holdId === input.holdId)) {
        throw new BusinessRuleError({
          code: 'agent_reminder.hold_not_theirs',
          message:
            `Hold ${input.holdId} is not in the ledger of agent ` +
            `${entity.agentUserId}`,
          userMessage:
            `ההחזקה ${input.holdId} אינה של הסוכן הזה, ולכן אין להזכיר לו ` +
            'עליה. בדקו את מזהה ההחזקה.',
          publicDetails: { holdId: input.holdId },
        })
      }

      const minutes = minutesUntil(input.expiresAt, now)
      if (minutes === null) {
        throw new BusinessRuleError({
          code: 'agent_reminder.expiry_unreadable',
          message: `Unreadable expiry ${input.expiresAt}`,
          userMessage:
            'לא ניתן לקרוא את מועד הפקיעה של ההחזקה, ולכן אי אפשר לנסח תזכורת.',
        })
      }
      if (minutes <= 0) {
        // Not pedantry. "השריון שלך עומד לפוג" about a hold that expired two
        // hours ago sends an agent to a screen where the dates are already
        // back on sale, and teaches them the reminders are noise.
        throw new BusinessRuleError({
          code: 'agent_reminder.hold_already_expired',
          message:
            `Hold ${input.holdId} expired at ${input.expiresAt}, before ` +
            now.toISOString(),
          userMessage:
            `ההחזקה ${input.holdId} כבר פגה, ולכן אין על מה להזכיר. ` +
            'התאריכים חזרו למכירה.',
          publicDetails: { holdId: input.holdId, expiresAt: input.expiresAt },
        })
      }
    },

    /**
     * Nothing is written, and there is nothing dishonest about that.
     *
     * The agent network has no reminder table, and inventing one would be a
     * migration this work may not write. What exists is the audit trail, which
     * records that the business decided to remind this agent about this hold
     * at this moment — and the composed sentence, which is what a person then
     * sends by whatever means they actually have.
     */
    async execute({ input, entity, now }) {
      const minutes = minutesUntil(input.expiresAt, now) ?? 0

      return {
        agentUserId: entity.agentUserId,
        kind: input.kind,
        holdId: input.holdId,
        minutesLeft: minutes,
        message:
          `תזכורת: השריון שלך על ${input.unitLabel} יפוג בעוד ${minutes} דקות. ` +
          'אם העסקה בדרך — האריכו את השריון. אם לא — שחררו אותו כדי שהתאריכים ' +
          'יחזרו למכירה.',
        delivered: false,
        channel: null,
        handoff: 'manual',
      }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: entity.agentUserId,
        after: {
          holdId: result.holdId,
          minutesLeft: result.minutesLeft,
          delivered: false,
        },
        summary:
          `${context.auditActor.label} הכינה תזכורת לסוכן על שריון שיפוג בעוד ` +
          `${result.minutesLeft} דקות. התזכורת טרם נשלחה — אין ערוץ שליחה מוגדר.`,
      }
    },
  })

  /* ---------------------------------------------------- the opportunity -- */

  const publishOpportunity = defineOperation<
    OpportunityInput,
    null,
    PreparedOpportunity
  >({
    name: 'agent.opportunity.prepare',
    permission: 'agent.manage',
    resourceType: 'agent_opportunity',
    input: OPPORTUNITY_INPUT,

    /**
     * The unit's scope, then the calendar.
     *
     * There is nothing to load, so the pipeline's second authorization check
     * has no resource to work with — the same gap `agentHold.create` closes by
     * hand, and closed here the same way, against the unit this input names.
     *
     * Then the substance: the nights must actually be empty. An opportunity
     * published on nights that are sold is the agent-network twin of releasing
     * a hold that has not expired — a planning mistake that reaches an outsider
     * and costs the business a double sale to unpick.
     */
    async rule({ input, context, now }) {
      const { actor } = context
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }

      assertCan(
        actor,
        'agent.manage',
        inventoryResource({
          organizationId: actor.organizationId,
          propertyId: input.propertyId,
          unitId: input.unitId,
        }),
      )

      if (input.checkIn < now.toISOString().slice(0, 10)) {
        throw new BusinessRuleError({
          code: 'agent_opportunity.dates_past',
          message: `Opportunity check-in ${input.checkIn} is in the past`,
          userMessage: `אי אפשר לפרסם הזדמנות לתאריך ${input.checkIn} — הוא כבר עבר.`,
          publicDetails: { checkIn: input.checkIn },
        })
      }

      const result = await checkAvailability(
        availability,
        {
          organizationId: actor.organizationId,
          unitId: input.unitId,
          range,
        },
        { now },
      )

      if (!result.available) {
        // The blockers are deliberately NOT forwarded. `availability-view.ts`
        // makes the argument: a `booking` blocker names somebody else's sale
        // and a `hold` blocker announces that a rival agent is mid-deal, and
        // this refusal is one keystroke away from a notice that goes to the
        // whole network.
        throw new BusinessRuleError({
          code: 'agent_opportunity.not_free',
          message:
            `Unit ${input.unitId} is not available for ` +
            `${input.checkIn}..${input.checkOut}: ` +
            result.blockers.map((blocker) => blocker.kind).join(', '),
          userMessage:
            `${input.unitLabel} אינה פנויה בתאריכים ${formatRange(range)}, ` +
            'ולכן אין כאן הזדמנות לפרסם.',
          publicDetails: { unitId: input.unitId },
        })
      }
    },

    /** Composes the notice. Writes nothing — see the reminder's `execute`. */
    async execute({ input }) {
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }
      const nights = nightsBetween(range)
      const note =
        input.note !== null && input.note.trim().length > 0
          ? `\n${input.note.trim()}`
          : ''

      return {
        unitId: input.unitId,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights,
        notice:
          `הזדמנות: ${input.unitLabel} פנויה ${formatRange(range)} ` +
          `(${nights} לילות). מי שיש לו לקוח — דברו איתנו לפני שתסגרו.${note}`,
        published: false,
        priced: false,
        audience: 'agent_network',
      }
    },

    audit({ input, result, context }) {
      return {
        resourceId: result.unitId,
        propertyId: input.propertyId,
        after: {
          unitId: result.unitId,
          checkIn: result.checkIn,
          checkOut: result.checkOut,
          nights: result.nights,
          published: false,
        },
        summary:
          `${context.auditActor.label} הכינה הזדמנות לרשת הסוכנים: ` +
          `${input.unitLabel}, ${formatRange({ checkIn: result.checkIn, checkOut: result.checkOut })} ` +
          `(${result.nights} לילות). ההזדמנות טרם פורסמה ולא נקבע לה מחיר.`,
      }
    },
  })

  return { sendReminder, publishOpportunity }
}
