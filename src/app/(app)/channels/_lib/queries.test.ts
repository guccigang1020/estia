/**
 * The channels read, and the claim it has to keep honest.
 *
 * The screen says nothing is connected. That sentence is worth almost nothing
 * unless something checks it, so this file checks the two halves separately:
 *
 *   · `connectionState` answers "connected" with `false` and lists what is
 *     missing — and the *type* says `false` rather than `boolean`, so the day
 *     an integration exists this file stops compiling and somebody has to look
 *     at it. A hard-coded `false` that quietly kept being right is the failure
 *     mode of every "coming soon" screen.
 *   · `channelPicture` counts real bookings whose source says they came from an
 *     OTA, which is a different and true thing, and is what makes the screen
 *     worth opening at all.
 *
 * ── The vocabulary is consumed, never extended ────────────────────────────
 *
 * `OTA_SOURCES` is a subset of `BOOKING_SOURCES` and the test below asserts the
 * subset relation against the contract. Naming a channel the enum does not carry
 * would produce a query the database refuses; classifying a source into neither
 * list would count it as direct, which understates exactly the channel cost a
 * business is measuring.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { BOOKING_SOURCES } from '@/lib/booking'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoDataset } from '@/lib/demo/types'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { OTA_SOURCES, channelPicture, connectionState } from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(dataset: DemoDataset = DEMO_DATASET): Db {
  return createDemoClient(dataset) as unknown as Db
}

async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(client()),
    DEMO_PLANS.find((plan) => plan.code === planCode)!,
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) throw new Error(resolution.reason)
  return resolution.actor
}

async function pictureFor(personaId: string) {
  return channelPicture({
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
    propertyId: null,
  })
}

/* ======================================================== the vocabulary == */

describe('the channel vocabulary', () => {
  it('is a subset of the frozen booking-source contract', () => {
    // `BOOKING_SOURCES` in `booking/types.ts` is consumed, never redefined.
    // A value this file could spell but the enum does not carry would produce a
    // query Postgres refuses.
    for (const source of OTA_SOURCES) {
      expect(BOOKING_SOURCES).toContain(source)
    }
  })

  it('leaves the direct sources out, and the agent ones too', () => {
    // The four that are not channels. `agent` and `agency` are the distribution
    // section's *other* half and counting them here would double-count the
    // network against itself.
    expect(OTA_SOURCES).not.toContain('direct_website')
    expect(OTA_SOURCES).not.toContain('direct_manual')
    expect(OTA_SOURCES).not.toContain('agent')
    expect(OTA_SOURCES).not.toContain('agency')

    // Everything else in the contract is a channel, so nothing is unclassified.
    const rest = BOOKING_SOURCES.filter(
      (source) =>
        !['direct_website', 'direct_manual', 'agent', 'agency'].includes(
          source,
        ),
    )
    expect([...OTA_SOURCES].sort()).toEqual([...rest].sort())
  })
})

/* ======================================================== the connection == */

describe('whether anything is connected', () => {
  it('says no, and the type says no rather than "not yet"', async () => {
    const state = connectionState(await pictureFor('owner'))

    // `anyConnected` is typed `false`, not `boolean`. The day a connection
    // record exists this assertion and that type both have to be revisited
    // deliberately — which is the difference between an honest empty state and
    // a stale one.
    expect(state.anyConnected).toBe(false)
  })

  it('lists what would have to exist, rather than saying "coming soon"', async () => {
    const state = connectionState(await pictureFor('owner'))

    // Four records: a connection, a listing mapping, a sync cursor and an
    // idempotency key per inbound reservation. "Coming soon" is a sentence
    // nobody can plan around; this is one they can.
    expect(state.missing).toHaveLength(4)
    for (const piece of state.missing) {
      expect(piece.trim().length).toBeGreaterThan(0)
    }
  })

  it('never confuses "we know about these bookings" with "the calendars are in step"', async () => {
    // The two are reported as separate fields on purpose, and the demo business
    // is exactly the case that makes it matter: it genuinely has channel
    // bookings and genuinely has no synchronisation. Collapsing the two is how
    // the same night gets sold twice.
    const state = connectionState(await pictureFor('owner'))

    expect(state.manualChannelBookings).toBe(true)
    expect(state.anyConnected).toBe(false)
  })

  it('does not claim manual channel bookings where there are none', async () => {
    // The other side of the same flag: a business with no OTA-sourced bookings
    // must not be shown a note about ones it typed in.
    const bookings = DEMO_DATASET.tables['bookings'] ?? []
    const noChannels: DemoDataset = {
      ...DEMO_DATASET,
      tables: {
        ...DEMO_DATASET.tables,
        bookings: bookings.filter(
          (row) =>
            !(OTA_SOURCES as readonly string[]).includes(String(row.source)),
        ),
      },
    }

    const picture = await channelPicture({
      db: client(noChannels),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    expect(picture.otaBookings).toBe(0)
    expect(connectionState(picture).manualChannelBookings).toBe(false)
  })
})

/* ============================================================ the counts == */

describe('what the channels have produced', () => {
  it('counts the channel bookings the business typed in by hand', async () => {
    const picture = await pictureFor('owner')

    // The demo business genuinely takes bookings from Airbnb and Booking.com —
    // somebody enters them — and this is the sentence the screen leads its
    // second panel with. It is also the point: ten real channel bookings and
    // nothing synchronised is a business one manual slip away from selling the
    // same night twice.
    expect(picture.readable).toBe(true)
    expect(picture.totalBookings).toBeGreaterThan(0)
    expect(picture.otaBookings).toBeGreaterThan(0)
    expect(picture.otaBookings).toBeLessThan(picture.totalBookings)

    // Cross-checked against the dataset itself rather than against a number
    // typed here, so a booking added to the fixture cannot silently make this
    // assertion stale.
    const seededOta = (DEMO_DATASET.tables['bookings'] ?? []).filter((row) =>
      (OTA_SOURCES as readonly string[]).includes(String(row.source)),
    ).length
    expect(picture.otaBookings).toBe(seededOta)

    // Every channel is listed, including the ones at zero. Dropping those rows
    // would make the screen look as though the channels themselves do not
    // exist, which is a different claim from "nothing came through them".
    expect(picture.channels).toHaveLength(OTA_SOURCES.length)
    expect(picture.channels.some((channel) => channel.bookingCount === 0)).toBe(
      true,
    )
  })

  it('labels each channel with what was actually typed, and totals it', async () => {
    const picture = await pictureFor('owner')

    const airbnb = picture.channels.find(
      (channel) => channel.source === 'airbnb',
    )!
    const bookingCom = picture.channels.find(
      (channel) => channel.source === 'booking_com',
    )!

    expect(airbnb.bookingCount).toBeGreaterThan(0)
    expect(bookingCom.bookingCount).toBeGreaterThan(0)

    // `source_channel` is free text beside the source, and it is shown as
    // typed rather than normalised into something nobody wrote.
    expect(airbnb.labels).toEqual(['airbnb.co.il'])
    expect(bookingCom.labels).toEqual(['booking.com'])

    expect(Number.isInteger(airbnb.revenueAgorot)).toBe(true)
    expect(airbnb.revenueAgorot).toBeGreaterThan(0)

    // The per-channel counts add up to the headline figure, so the tiles and
    // the sentence above them cannot disagree.
    expect(
      picture.channels.reduce((sum, channel) => sum + channel.bookingCount, 0),
    ).toBe(picture.otaBookings)
  })

  it('withholds the revenue rather than reporting zero', async () => {
    const actor = await actorFor('sales-agent')
    expect(holdsGrant(actor, 'booking.view_price')).toBe(false)

    const picture = await channelPicture({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    // `null`, never 0. "This channel earned ₪0" and "you may not see what this
    // channel earned" are opposite statements about money.
    expect(
      picture.channels.every((channel) => channel.revenueAgorot === null),
    ).toBe(true)
  })

  it('reports "not readable" rather than "no channel bookings" to a cleaner', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'booking.view')).toBe(false)

    const picture = await channelPicture({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    // The distinction the `readable` flag exists for: a cleaner is told the
    // breakdown is not theirs to see, not that the business has never taken a
    // channel booking.
    expect(picture.readable).toBe(false)
    expect(picture.channels).toEqual([])
    expect(picture.totalBookings).toBe(0)
  })
})
