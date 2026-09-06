import { describe, expect, it } from 'vitest'

import { inQuietHours, type QuietWindow } from './quiet-hours'

const NIGHT: QuietWindow = {
  enabled: true,
  start: '22:00',
  end: '07:00',
  timezone: 'Asia/Jerusalem',
}

/** 23:40 in Jerusalem on a summer evening. */
const LATE = new Date('2026-09-06T20:40:00.000Z')
/** 12:00 in Jerusalem. */
const MIDDAY = new Date('2026-09-06T09:00:00.000Z')

describe('the quiet window', () => {
  it('is inside at night', () => {
    expect(inQuietHours(NIGHT, LATE)).toBe(true)
  })

  it('is outside during the working day', () => {
    expect(inQuietHours(NIGHT, MIDDAY)).toBe(false)
  })

  it('answers in the business s zone, not the machine s', () => {
    expect(inQuietHours({ ...NIGHT, timezone: 'UTC' }, LATE)).toBe(false)
    expect(inQuietHours({ ...NIGHT, timezone: 'Asia/Jerusalem' }, LATE)).toBe(
      true,
    )
  })

  it('says no when the business has not switched it on', () => {
    expect(inQuietHours({ ...NIGHT, enabled: false }, LATE)).toBe(false)
  })
})

describe('a configuration that cannot be read', () => {
  // Both failures fail towards quiet. Being wrong in this direction costs a
  // person a button press; being wrong in the other costs a guest a telephone
  // call at three in the morning.
  it('treats an unparseable window as night', () => {
    expect(inQuietHours({ ...NIGHT, start: 'evening' }, MIDDAY)).toBe(true)
    expect(inQuietHours({ ...NIGHT, end: '25:00' }, MIDDAY)).toBe(true)
  })

  it('treats an unknown time zone as night rather than crashing', () => {
    expect(inQuietHours({ ...NIGHT, timezone: 'Asia/Jerusalm' }, MIDDAY)).toBe(
      true,
    )
  })

  it('still says no when quiet hours are off, whatever the window says', () => {
    expect(
      inQuietHours({ ...NIGHT, enabled: false, start: 'evening' }, MIDDAY),
    ).toBe(false)
  })
})
