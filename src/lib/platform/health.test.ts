import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '@/lib/persistence/fake-client'

import { loadPlatformHealth, UNCONNECTED_PANELS } from './health'

/**
 * The console must never print a number it did not read.
 *
 * That claim is easy to make and easy to break: the natural way to write a
 * dashboard is a row of counters that default to zero, and a zero that means
 * "we have no source" is indistinguishable on screen from a zero that means
 * "nothing is wrong". Somebody then does nothing about it, which is exactly
 * what a zero invites.
 *
 * So the tests below are about absence rather than about arithmetic.
 */

const NOW = new Date('2026-09-05T09:00:00Z')

function client(responses: Record<string, unknown>) {
  return new FakeSupabaseClient({
    responses: responses as never,
  }).asDb()
}

const EMPTY = {
  organizations: { data: [] },
  organization_subscriptions: { data: [] },
  audit_events: { data: [] },
  platform_support_sessions: { data: [] },
}

describe('the panels with no source', () => {
  it('carries no place to put a number', () => {
    for (const panel of UNCONNECTED_PANELS) {
      expect(panel.source.kind).toBe('not_connected')
      // The type has no `metrics` on this branch, and the value does not
      // either — a panel cannot acquire a figure by accident.
      expect('metrics' in panel.source).toBe(false)
    }
  })

  it('says what is missing in a sentence, not as a dash', () => {
    for (const panel of UNCONNECTED_PANELS) {
      const reason =
        panel.source.kind === 'not_connected' ? panel.source.reason : ''
      expect(reason.length).toBeGreaterThan(40)
      expect(reason).not.toBe('—')
    }
  })

  it('distinguishes "no such table" from "deliberately not opened"', () => {
    const payments = UNCONNECTED_PANELS.find(
      (panel) => panel.key === 'payment_provider',
    )
    const jobs = UNCONNECTED_PANELS.find((panel) => panel.key === 'jobs')

    // The payment tables exist and are not opened to platform staff. Saying
    // "no data" there would be untrue, and would invite somebody to go
    // looking for a source that is already sitting behind a deliberate
    // refusal.
    expect(
      payments?.source.kind === 'not_connected' ? payments.source.reason : '',
    ).toContain('payment_provider_events')

    expect(
      jobs?.source.kind === 'not_connected' ? jobs.source.reason : '',
    ).toContain('אין במסד הנתונים')
  })

  it('covers all five capabilities the console was asked to report on', () => {
    expect(UNCONNECTED_PANELS.map((panel) => panel.key)).toEqual([
      'integrations',
      'payment_provider',
      'jobs',
      'ai_usage',
      'security_events',
    ])
  })
})

describe('loadPlatformHealth', () => {
  it('renders an empty installation as zeros it actually counted', async () => {
    const health = await loadPlatformHealth(client(EMPTY), NOW)

    expect(health.failures).toEqual([])

    const accounts = health.panels.find((panel) => panel.key === 'accounts')
    expect(accounts?.source.kind).toBe('connected')

    // A counted zero is legitimate and is shown. The distinction this file
    // exists for is between this and a zero nobody counted.
    const total =
      accounts?.source.kind === 'connected'
        ? accounts.source.metrics.find((metric) => metric.label === 'סה״כ')
        : undefined
    expect(total?.value).toBe('0')
  })

  it('counts what it read and flags what deserves attention', async () => {
    const health = await loadPlatformHealth(
      client({
        ...EMPTY,
        organizations: {
          data: [
            { status: 'active' },
            { status: 'active' },
            { status: 'suspended' },
            { status: 'onboarding' },
          ],
        },
        organization_subscriptions: {
          data: [
            { status: 'active', trial_ends_at: null },
            // Ends in three days — inside the fourteen-day horizon.
            { status: 'trialing', trial_ends_at: '2026-09-08T09:00:00Z' },
            // Ended a week ago and was never converted.
            { status: 'trialing', trial_ends_at: '2026-08-29T09:00:00Z' },
            { status: 'past_due', trial_ends_at: null },
          ],
        },
      }),
      NOW,
    )

    const metrics = (key: string) => {
      const panel = health.panels.find((entry) => entry.key === key)
      return panel?.source.kind === 'connected' ? panel.source.metrics : []
    }

    const value = (key: string, label: string) =>
      metrics(key).find((metric) => metric.label.startsWith(label))?.value

    expect(value('accounts', 'סה״כ')).toBe('4')
    expect(value('accounts', 'מושהים')).toBe('1')
    expect(value('subscriptions', 'התנסות שנגמרת')).toBe('1')
    expect(value('subscriptions', 'התנסות שפגה')).toBe('1')
    expect(value('subscriptions', 'בפיגור')).toBe('1')

    const suspended = metrics('accounts').find(
      (metric) => metric.label === 'מושהים',
    )
    expect(suspended?.attention).toBe(true)
  })

  it('reports a failed read as a failure, never as an empty panel', async () => {
    const health = await loadPlatformHealth(
      client({
        ...EMPTY,
        organizations: {
          error: { code: '42501', message: 'permission denied' },
        },
      }),
      NOW,
    )

    // The panel is absent and the failure is named. A table that could not be
    // read must never render as a table with nothing in it: those are opposite
    // statements about the business.
    expect(
      health.panels.find((panel) => panel.key === 'accounts'),
    ).toBeUndefined()
    expect(health.failures).toHaveLength(1)
    expect(health.failures[0]).toContain('permission denied')

    // And one unreadable table does not blank the others.
    expect(
      health.panels.find((panel) => panel.key === 'subscriptions'),
    ).toBeDefined()
  })

  it('always appends the unconnected panels, whatever else happened', async () => {
    const health = await loadPlatformHealth(client(EMPTY), NOW)

    for (const panel of UNCONNECTED_PANELS) {
      expect(health.panels).toContainEqual(panel)
    }
  })
})
