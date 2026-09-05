import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '../persistence/fake-client'

import {
  SupabaseNotificationRepository,
  settingsOrDefaults,
} from './repository'
import { NOW, ORG, PROPERTY } from './testing'
import type { PlannedNotification } from './routing'

const USER = 'user-finance_manager'

function settingsRow() {
  return {
    id: 's-1',
    organization_id: ORG,
    enabled_channels: ['in_app', 'email'],
    quiet_hours_enabled: true,
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '07:00:00',
    timezone: 'Asia/Jerusalem',
    urgent_overrides_quiet_hours: true,
    default_escalation_minutes: 30,
    retain_read_days: 30,
    version: 3,
  }
}

function planned(): PlannedNotification {
  return {
    recipientUserId: USER,
    eventName: 'payment.failed',
    category: 'money',
    severity: 'urgent',
    organizationId: ORG,
    propertyId: PROPERTY,
    resourceType: 'payment',
    resourceId: 'pay-1',
    title: 'תשלום נכשל',
    body: 'חיוב לא עבר.',
    actionHref: '/finance',
    requiredGrant: 'payment.view',
    dedupeKey: 'k1',
    correlationId: 'corr-1',
    occurredAt: NOW,
    escalationLevel: 0,
    escalatedFrom: null,
    deliveries: [],
  }
}

describe('every read is scoped by organization in the query as well as by RLS', () => {
  it('filters the settings read', async () => {
    const client = new FakeSupabaseClient({
      responses: { notification_settings: { data: settingsRow() } },
    })

    await new SupabaseNotificationRepository(client.asDb()).loadSettings(ORG)

    const query = client.queriesFor('notification_settings')[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
  })

  it('filters the inbox read by organization AND recipient', async () => {
    const client = new FakeSupabaseClient({
      responses: { notifications: { data: [] } },
    })

    await new SupabaseNotificationRepository(client.asDb()).listInbox(ORG, USER)

    const query = client.queriesFor('notifications')[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    // The policy already refuses somebody else's row. The filter is what makes
    // a mistake in the adapter fail as "nothing found" rather than as one
    // person reading another's alerts under `service_role`.
    expect(hasFilter(query, 'eq', 'recipient_user_id', USER)).toBe(true)
    expect(hasFilter(query, 'is', 'dismissed_at', null)).toBe(true)
  })

  it('filters the preference read by organization AND user', async () => {
    const client = new FakeSupabaseClient({
      responses: { notification_preferences: { data: [] } },
    })

    await new SupabaseNotificationRepository(client.asDb()).listPreferences(
      ORG,
      USER,
    )

    const query = client.queriesFor('notification_preferences')[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'eq', 'user_id', USER)).toBe(true)
  })

  it('scopes a state change to the organization and the recipient', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'notifications:update': { data: null } },
    })

    await new SupabaseNotificationRepository(client.asDb()).markState(
      ORG,
      USER,
      'n-1',
      'acted',
      NOW,
    )

    const query = client.queriesFor('notifications')[0]
    expect(query.verb).toBe('update')
    expect(query.payload).toEqual({ acted_at: NOW.toISOString() })
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'eq', 'recipient_user_id', USER)).toBe(true)
    expect(hasFilter(query, 'eq', 'id', 'n-1')).toBe(true)
  })
})

describe('the dedupe collision is the system working, not failing', () => {
  it('reads back the existing row and reports created: false', async () => {
    const existing = {
      id: 'n-existing',
      organization_id: ORG,
      property_id: PROPERTY,
      recipient_user_id: USER,
      event_name: 'payment.failed',
      category: 'money',
      severity: 'urgent',
      resource_type: 'payment',
      resource_id: 'pay-1',
      title: 'תשלום נכשל',
      body: 'חיוב לא עבר.',
      action_href: '/finance',
      required_grant: 'payment.view',
      dedupe_key: 'k1',
      correlation_id: 'corr-1',
      occurred_at: NOW.toISOString(),
      escalated_from: null,
      escalation_level: 0,
      read_at: null,
      dismissed_at: null,
      acted_at: null,
      created_at: NOW.toISOString(),
    }

    const client = new FakeSupabaseClient({
      responses: {
        'notifications:insert': {
          error: { code: '23505', message: 'duplicate key' },
        },
        'notifications:select': { data: existing },
      },
    })

    const outcome = await new SupabaseNotificationRepository(
      client.asDb(),
    ).insertNotification(planned())

    expect(outcome.created).toBe(false)
    expect(outcome.record.id).toBe('n-existing')
  })

  it('still throws for an error that is not the dedupe constraint', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'notifications:insert': {
          error: { code: '42501', message: 'permission denied' },
        },
      },
    })

    await expect(
      new SupabaseNotificationRepository(client.asDb()).insertNotification(
        planned(),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('mapping', () => {
  it('trims a Postgres time to what a person types', async () => {
    const client = new FakeSupabaseClient({
      responses: { notification_settings: { data: settingsRow() } },
    })

    const loaded = await new SupabaseNotificationRepository(
      client.asDb(),
    ).loadSettings(ORG)

    expect(loaded?.quietHoursStart).toBe('22:00')
    expect(loaded?.quietHoursEnd).toBe('07:00')
    expect(loaded?.enabledChannels).toEqual(['in_app', 'email'])
  })

  it('refuses a vocabulary the migration and the code disagree about', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        notification_preferences: {
          data: [
            {
              id: 'p-1',
              organization_id: ORG,
              user_id: USER,
              category: 'money',
              channel: 'carrier_pigeon',
              enabled: true,
              min_severity: 'info',
            },
          ],
        },
      },
    })

    // Loud at the mapping boundary rather than a blank cell three screens
    // later.
    await expect(
      new SupabaseNotificationRepository(client.asDb()).listPreferences(
        ORG,
        USER,
      ),
    ).rejects.toThrow(/carrier_pigeon/)
  })
})

describe('no row is a complete configuration', () => {
  it('resolves to the documented defaults rather than to an empty state', () => {
    const resolved = settingsOrDefaults(ORG, null)

    expect(resolved.enabledChannels).toEqual(['in_app'])
    expect(resolved.quietHoursEnabled).toBe(true)
    expect(resolved.urgentOverridesQuietHours).toBe(true)
    // Version zero says out loud that nothing was ever saved, without making
    // the caller decide what a `null` meant.
    expect(resolved.version).toBe(0)
  })
})
