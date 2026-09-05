/**
 * The write paths.
 *
 * ══ TWO OF THEM GO THROUGH `defineOperation`, AND ONE CANNOT ════════════════
 *
 * `setNotificationSettings` and `setEscalationDefault` are ordinary business
 * operations: they change something for the whole organization, they require
 * `organization.settings.edit`, and they go authorization → validation → rule
 * → transaction → audit event → idempotency with no way to reach the write
 * without the checks.
 *
 * `setPreference` and `markNotificationState` are a person acting on their own
 * rows, and there is no grant in `src/lib/authz/permissions.ts` that every
 * member holds. A cleaner's whole preset is four grants —
 * `task.view`, `task.update`, `task.complete`, `incident.create` — and a
 * cleaner must obviously be able to mute their own SMS and mark their own
 * notification read.
 *
 * The three ways out, and why this is the one taken:
 *
 *   · Give them `organization.settings.edit`. That is an authority over the
 *     business, handed out so somebody can turn off a notification. No.
 *   · Pick some grant the person happens to hold — `task.view` for a cleaner.
 *     A gate whose answer varies by role for a decision that does not is worse
 *     than no gate, because it looks like a rule.
 *   · Invent `notification.preferences.manage` and grant it to every preset.
 *     This is the right answer and it is **requested rather than taken**:
 *     `src/lib/authz/**` belongs to another owner and the catalogue is not
 *     mine to edit.
 *
 * So until that grant exists, these two are written here with everything the
 * pipeline gives except the grant assertion that has no grant to assert —
 * membership is still checked, the input is still validated, the write is
 * still transactional, and the audit event is still recorded through
 * `recordAuditEvent`, the same function the pipeline itself calls. The floor
 * that actually enforces this is 0043: `notification_preferences` and
 * `notifications` are readable and writable only where
 * `user_id = (select auth.uid())`, so a crafted request reaches the database
 * and is refused there regardless of what this file does.
 *
 * When the grant lands, `PERSONAL_GRANT` below becomes it and these two become
 * `defineOperation` like everything else. That is a small, obvious change, and
 * it is written down here so it is not a discovery.
 */

import { recordAuditEvent, type AuditWriter } from '../audit/pipeline'
import type { AuditActor } from '../audit/events'
import { AppError, BusinessRuleError, ValidationError } from '../errors'
import type { Actor } from '../authz/can'
import { defineOperation, s, type TransactionHandle } from '../service'

import { CATEGORY_LABEL, CHANNEL_LABEL, SEVERITY_LABEL } from './labels'
import type { NotificationRepository } from './repository'
import { settingsOrDefaults } from './repository'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SEVERITIES,
  type NotificationSettings,
} from './types'

/**
 * The grant a personal preference change would require, if one existed.
 *
 * `null` today. Named as a constant rather than left implicit so the
 * substitution is one line and so a reader can see, from this file alone, that
 * the absence is a known state and not an omission.
 */
export const PERSONAL_GRANT: string | null = null

/* ------------------------------------------------------ the organization -- */

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

export interface NotificationOperationDeps {
  repository: NotificationRepository
}

export function defineNotificationOperations(deps: NotificationOperationDeps) {
  const { repository } = deps

  const setNotificationSettings = defineOperation<
    {
      enabledChannels: readonly (typeof NOTIFICATION_CHANNELS)[number][]
      quietHoursEnabled: boolean
      quietHoursStart: string
      quietHoursEnd: string
      timezone: string
      urgentOverridesQuietHours: boolean
      defaultEscalationMinutes: number
      retainReadDays: number
    },
    null,
    { settings: NotificationSettings }
  >({
    name: 'notification.settings.set',
    permission: 'organization.settings.edit',
    resourceType: 'notification_settings',
    input: s.object({
      enabledChannels: s.arrayOf(
        s.enumOf(NOTIFICATION_CHANNELS, { label: 'ערוץ' }),
        { label: 'ערוצים פעילים', max: NOTIFICATION_CHANNELS.length },
      ),
      quietHoursEnabled: s.boolean({ label: 'שעות שקט' }),
      quietHoursStart: s.string({
        label: 'תחילת שעות שקט',
        pattern: CLOCK,
        patternMessage: 'יש להזין שעה בפורמט HH:MM, למשל 22:00.',
      }),
      quietHoursEnd: s.string({
        label: 'סוף שעות שקט',
        pattern: CLOCK,
        patternMessage: 'יש להזין שעה בפורמט HH:MM, למשל 07:00.',
      }),
      timezone: s.string({ label: 'אזור זמן', min: 1, max: 64 }),
      urgentOverridesQuietHours: s.boolean({
        label: 'התראות דחופות עוברות גם בשעות שקט',
      }),
      defaultEscalationMinutes: s.number({
        label: 'דקות עד הסלמה',
        integer: true,
        min: 1,
        max: 10080,
      }),
      retainReadDays: s.number({
        label: 'ימי שמירה של התראות שנקראו',
        integer: true,
        min: 1,
        max: 3650,
      }),
    }),

    /**
     * The two rules the database also holds.
     *
     * Checked here as well because a constraint violation reaches a person as
     * a 23514 with a constraint name in it, and "לא ניתן לכבות את הערוץ
     * במערכת" is a sentence somebody can act on.
     */
    rule({ input }) {
      if (!input.enabledChannels.includes('in_app')) {
        throw new BusinessRuleError({
          code: 'notifications.in_app_required',
          message: 'in_app was removed from enabled_channels',
          userMessage:
            'לא ניתן לכבות את הערוץ במערכת. הוא לא דורש שום חיבור חיצוני, והוא המקום היחיד שבו ההתראות נשמרות — בלעדיו המערכת מחליטה למי להודיע ואין לזה לאן להגיע.',
        })
      }

      if (
        input.quietHoursEnabled &&
        input.quietHoursStart === input.quietHoursEnd
      ) {
        throw new BusinessRuleError({
          code: 'notifications.quiet_window_empty',
          message: 'quiet hours start equals end',
          userMessage:
            'שעת ההתחלה ושעת הסיום זהות, כלומר שקט של 24 שעות. אם זו הכוונה, כבו את שעות השקט — כך זה גם ייקרא נכון על המסך.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const settings = await repository.saveSettings(
        context.actor.organizationId,
        {
          enabledChannels: input.enabledChannels,
          quietHoursEnabled: input.quietHoursEnabled,
          quietHoursStart: input.quietHoursStart,
          quietHoursEnd: input.quietHoursEnd,
          timezone: input.timezone,
          urgentOverridesQuietHours: input.urgentOverridesQuietHours,
          defaultEscalationMinutes: input.defaultEscalationMinutes,
          retainReadDays: input.retainReadDays,
        },
        context.actor.userId,
        tx,
      )

      return { settings }
    },

    audit({ input, result }) {
      const channels = input.enabledChannels
        .map((channel) => CHANNEL_LABEL[channel])
        .join(', ')

      const quiet = input.quietHoursEnabled
        ? `שעות שקט ${input.quietHoursStart}–${input.quietHoursEnd}`
        : 'ללא שעות שקט'

      return {
        // Names the channels and the window rather than "settings updated",
        // because the question somebody asks six weeks later is "when did we
        // turn the SMS off", and a generic summary cannot answer it.
        summary: `עודכנו הגדרות ההתראות: ערוצים פעילים — ${channels}; ${quiet}.`,
        resourceId: result.settings.id,
        after: {
          enabled_channels: [...input.enabledChannels],
          quiet_hours_enabled: input.quietHoursEnabled,
          quiet_hours_start: input.quietHoursStart,
          quiet_hours_end: input.quietHoursEnd,
          urgent_overrides_quiet_hours: input.urgentOverridesQuietHours,
        },
      }
    },
  })

  return { setNotificationSettings }
}

/* ----------------------------------------------------------- the person -- */

/**
 * Not an authorization decision — see the header. This is the membership
 * check the pipeline would have made first, made here so a suspended person's
 * write is refused before it reaches a policy that would also refuse it.
 */
function assertActiveMember(actor: Actor, organizationId: string): void {
  if (actor.organizationId !== organizationId) {
    throw new AppError({
      code: 'cross_organization',
      status: 403,
      message: 'preference write crossed an organization boundary',
      userMessage: 'הפעולה אינה שייכת למרחב העבודה הפעיל.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }

  if (actor.membershipStatus !== 'active') {
    throw new AppError({
      code: 'membership_not_active',
      status: 403,
      message: `membership is ${actor.membershipStatus}`,
      userMessage:
        'החברות שלך בארגון אינה פעילה, ולכן לא ניתן לשנות את העדפות ההתראות.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

export interface PersonalWriteContext {
  actor: Actor
  auditActor: AuditActor
  correlationId: string
  audit: AuditWriter
  now?: Date
  tx?: TransactionHandle
}

/**
 * One cell of one person's grid.
 *
 * Audited like everything else. "דנה כיבתה SMS על כספים" is a sentence
 * somebody needs when a payment alert did not arrive, and a preference change
 * that left no trace would make that unanswerable.
 */
export async function setPreference(
  repository: NotificationRepository,
  context: PersonalWriteContext,
  input: {
    category: (typeof NOTIFICATION_CATEGORIES)[number]
    channel: (typeof NOTIFICATION_CHANNELS)[number]
    enabled: boolean
    minSeverity: (typeof NOTIFICATION_SEVERITIES)[number]
  },
): Promise<void> {
  const organizationId = context.actor.organizationId
  assertActiveMember(context.actor, organizationId)

  const known = {
    category: (NOTIFICATION_CATEGORIES as readonly string[]).includes(
      input.category,
    ),
    channel: (NOTIFICATION_CHANNELS as readonly string[]).includes(
      input.channel,
    ),
    minSeverity: (NOTIFICATION_SEVERITIES as readonly string[]).includes(
      input.minSeverity,
    ),
  }

  // Validated here rather than trusted from the form, because a Server Action
  // is a public endpoint reachable by a crafted POST whatever the screen chose
  // to render.
  if (!known.category || !known.channel || !known.minSeverity) {
    throw new ValidationError([
      {
        field: !known.category
          ? 'category'
          : !known.channel
            ? 'channel'
            : 'minSeverity',
        code: 'unknown_value',
        message: 'הערך שנשלח אינו מוכר.',
      },
    ])
  }

  const saved = await repository.savePreference(
    organizationId,
    context.actor.userId,
    input,
    context.tx,
  )

  await recordAuditEvent(
    {
      actor: context.auditActor,
      context: {
        organizationId,
        propertyId: null,
        requestId: context.correlationId,
      },
      action: 'notification.preference.set',
      resourceType: 'notification_preference',
      resourceId: saved.id,
      after: {
        category: input.category,
        channel: input.channel,
        enabled: input.enabled,
        min_severity: input.minSeverity,
      },
      summary: input.enabled
        ? `הופעלו התראות ${CATEGORY_LABEL[input.category]} בערוץ ${CHANNEL_LABEL[input.channel]}, מרמת ${SEVERITY_LABEL[input.minSeverity]} ומעלה.`
        : `כובו התראות ${CATEGORY_LABEL[input.category]} בערוץ ${CHANNEL_LABEL[input.channel]}.`,
    },
    context.audit,
    { occurredAt: context.now ?? new Date(), tx: context.tx },
  )
}

/**
 * Read, dismissed, or acted upon.
 *
 * Deliberately NOT audited. An audit row per bell-panel open would bury the
 * events that matter under thousands that do not — and `notifications.read_at`
 * is itself the record of when this person saw it, with a timestamp, on the
 * row the question is about. A second copy in `audit_events` would be the same
 * fact in two places, which is how two places come to disagree.
 *
 * `acted` is the one that carries weight, because escalation reads it, and its
 * consequence is visible immediately: the escalation stops.
 */
export async function markNotificationState(
  repository: NotificationRepository,
  context: Pick<PersonalWriteContext, 'actor' | 'now' | 'tx'>,
  notificationId: string,
  state: 'read' | 'dismissed' | 'acted',
): Promise<void> {
  const organizationId = context.actor.organizationId
  assertActiveMember(context.actor, organizationId)

  await repository.markState(
    organizationId,
    context.actor.userId,
    notificationId,
    state,
    context.now ?? new Date(),
    context.tx,
  )
}

/* ------------------------------------------------------------------ read -- */

/**
 * The organization's settings, resolved.
 *
 * Exported from here rather than from the repository because every caller that
 * writes also reads, and a screen that showed the raw `null` would have to
 * decide for itself what "never configured" means. It is decided once, in
 * `settingsOrDefaults`.
 */
export async function loadSettings(
  repository: NotificationRepository,
  organizationId: string,
): Promise<NotificationSettings> {
  return settingsOrDefaults(
    organizationId,
    await repository.loadSettings(organizationId),
  )
}
