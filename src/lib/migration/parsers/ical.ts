/**
 * An iCal calendar, turned into booking rows.
 *
 * ── Why this is the parser that matters ───────────────────────────────────
 *
 * The Israeli operator this capability exists for does not have a database
 * export. They have a villa on Airbnb, one on Booking.com, a WhatsApp group and
 * a calendar. What every one of those platforms gives them — the one export
 * that is universal, free and already in their hands — is an iCal URL. If
 * ESTIA reads that file, three years of occupancy moves. If it does not, the
 * operator is told to retype it, and nobody retypes three years.
 *
 * ── The half-open rule, which is where this parser earns its keep ─────────
 *
 * RFC 5545 says `DTEND` is exclusive for a `VALUE=DATE` event: a guest staying
 * the nights of the 3rd and 4th is published as `DTSTART:20260103` /
 * `DTEND:20260105`. ESTIA's `DateRange` is the same shape — `checkOut` is the
 * day the guest leaves and the next guest may arrive. So the two agree exactly
 * and nothing is adjusted.
 *
 * The temptation to subtract a day here is strong and it is wrong. Doing it
 * turns every same-day changeover into a false conflict and quietly deletes one
 * sellable night per turnover across the whole calendar — which
 * `booking/availability.ts` says at length about its own overlap test, and this
 * is the same rule arriving from the other direction.
 *
 * `DTEND` with a *time* (`DTSTART:20260103T150000Z`) is a different animal and
 * is not exclusive in the same sense, so the date part is taken as-is and the
 * clock discarded: ESTIA stores a stay as two dates, and an hour imported from
 * a channel would imply a precision the channel never meant.
 *
 * ── What a channel actually writes in SUMMARY ─────────────────────────────
 *
 * Nothing useful, most of the time. Airbnb publishes `Reserved`, Booking.com
 * publishes `CLOSED - Not available`, and the guest's name — when there is one
 * at all — is in `DESCRIPTION` behind a label. So the guest name is *recovered*
 * where possible and left explicitly unknown where it is not, rather than
 * filled with the summary text, which would create three hundred guests named
 * "Reserved".
 *
 * An event whose summary marks it unavailable rather than sold is emitted as a
 * blocked-date row, not a booking. Importing "not available" as a guest stay
 * would put a fictional booking on the calendar and, worse, would make the
 * operator's occupancy report wrong in the flattering direction.
 */

import type {
  ImportEntity,
  ParsedFile,
  SourceRow,
  ValidationIssue,
} from '../types'

/** The column names this parser emits. Ordinary strings, mapped like any file. */
export const ICAL_COLUMNS = [
  'UID',
  'SUMMARY',
  'DESCRIPTION',
  'DTSTART',
  'DTEND',
  'LOCATION',
  'STATUS',
] as const

/**
 * Undo RFC 5545 line folding.
 *
 * A continuation line begins with a space or a tab and belongs to the previous
 * one. Airbnb folds long descriptions at seventy-five octets, so a parser that
 * skips this reads half a guest name and a line starting with a space.
 */
export function unfold(text: string): readonly string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const unfolded: string[] = []

  for (const line of lines) {
    if (
      unfolded.length > 0 &&
      (line.startsWith(' ') || line.startsWith('\t'))
    ) {
      unfolded[unfolded.length - 1] += line.slice(1)
      continue
    }
    unfolded.push(line)
  }

  return unfolded
}

/** `DTSTART;VALUE=DATE:20260103` → name `DTSTART`, value `20260103`. */
function splitProperty(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':')
  if (colon === -1) return null

  const rawName = line.slice(0, colon)
  const semicolon = rawName.indexOf(';')
  const name = (semicolon === -1 ? rawName : rawName.slice(0, semicolon))
    .trim()
    .toUpperCase()

  return { name, value: line.slice(colon + 1) }
}

/**
 * Unescape the text escapes RFC 5545 defines.
 *
 * `\n` is the one that matters: a description holding a guest name on one line
 * and a confirmation code on the next arrives as a single line with a literal
 * backslash-n in it, and the name extractor below would not find the label.
 */
export function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/**
 * `20260103` or `20260103T150000Z` → `2026-01-03`.
 *
 * The clock is discarded deliberately — see the header. `null` for anything
 * that is not a date at all, which becomes a refused row with its line number
 * rather than an exception.
 */
export function icalDate(value: string): string | null {
  const digits = value.trim().replace(/^TZID=[^:]*:/i, '')
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(digits)
  if (!match) return null

  const [, year, month, day] = match
  if (year === undefined || month === undefined || day === undefined) {
    return null
  }

  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12) return null
  if (dayNumber < 1 || dayNumber > 31) return null

  return `${year}-${month}-${day}`
}

/**
 * The labels channels put the guest's name behind, in a description.
 *
 * Hebrew first, because a Hebrew-language Airbnb account publishes a Hebrew
 * description, and English after it. Anything not matched leaves the name
 * unknown rather than guessed — see the header.
 */
const NAME_LABELS: readonly string[] = [
  'שם האורח',
  'שם אורח',
  'אורח',
  'guest name',
  'guest',
  'name',
  'booked by',
]

/** The guest's name out of a description, or `null` when it is not in there. */
export function guestNameFrom(description: string): string | null {
  for (const line of description.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue

    const label = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (value.length === 0) continue

    if (NAME_LABELS.some((candidate) => label === candidate)) return value
  }
  return null
}

/**
 * Summaries that mean "this unit is off sale", not "somebody is staying".
 *
 * Matched as a substring and case-insensitively, because the exact strings
 * differ per channel and per locale and an exact list would rot. The direction
 * of the mistake is chosen: a stay wrongly read as a block loses a booking the
 * operator can see is missing, while a block wrongly read as a stay invents a
 * guest and inflates the occupancy report.
 */
const UNAVAILABLE_MARKERS: readonly string[] = [
  'not available',
  'unavailable',
  'blocked',
  'closed',
  'לא זמין',
  'חסום',
  'תחזוקה',
]

export function marksUnavailable(summary: string): boolean {
  const text = summary.toLowerCase()
  return UNAVAILABLE_MARKERS.some((marker) => text.includes(marker))
}

/**
 * Parse a calendar.
 *
 * `entity` decides what comes out: asked for `bookings`, only the sold events
 * are emitted; asked for `blocked_dates`, only the unavailable ones. One file
 * is therefore imported twice, deliberately — two sessions, two dry runs, two
 * sets of conflicts — because they are two different kinds of fact and merging
 * them into one screen would make the operator decide about both at once.
 */
export function parseIcal(
  text: string,
  options: { entity: ImportEntity; unitName?: string },
): ParsedFile {
  const wantBlocks = options.entity === 'blocked_dates'
  const rows: SourceRow[] = []
  const problems: ValidationIssue[] = []

  let current: Record<string, string> | null = null
  let lineNumber = 0
  let startedAt = 0

  for (const line of unfold(text)) {
    lineNumber += 1
    const property = splitProperty(line)
    if (!property) continue

    if (property.name === 'BEGIN' && property.value.trim() === 'VEVENT') {
      current = {}
      startedAt = lineNumber
      continue
    }

    if (property.name === 'END' && property.value.trim() === 'VEVENT') {
      if (current !== null) {
        const row = eventRow(current, startedAt, options.unitName ?? '')
        if (row === null) {
          problems.push({
            rowNumber: startedAt,
            entity: options.entity,
            severity: 'error',
            code: 'not_a_date',
            field: null,
            column: 'DTSTART',
            value: current.DTSTART ?? null,
            message:
              `האירוע שמתחיל בשורה ${startedAt} חסר תאריך התחלה או סיום ` +
              'תקין, ולכן לא ניתן לקרוא ממנו שהות.',
          })
        } else if (marksUnavailable(row.cells.SUMMARY ?? '') === wantBlocks) {
          rows.push(row)
        }
      }
      current = null
      continue
    }

    if (current === null) continue
    if (ICAL_COLUMNS.some((name) => name === property.name)) {
      current[property.name] = unescapeText(property.value).trim()
    }
  }

  if (rows.length === 0 && problems.length === 0) {
    problems.push({
      rowNumber: 0,
      entity: options.entity,
      severity: 'error',
      code: 'empty_file',
      field: null,
      column: null,
      value: null,
      message: wantBlocks
        ? 'לא נמצאו ביומן אירועים שמסמנים חסימה.'
        : 'לא נמצאו ביומן אירועים שמייצגים שהות.',
    })
  }

  return {
    format: 'ical',
    columns: [...ICAL_COLUMNS, 'GUEST_NAME', 'UNIT'],
    rows,
    issues: problems,
  }
}

/** One `VEVENT` as a row, or `null` when its dates are unreadable. */
function eventRow(
  event: Readonly<Record<string, string>>,
  rowNumber: number,
  unitName: string,
): SourceRow | null {
  const checkIn = icalDate(event.DTSTART ?? '')
  const checkOut = icalDate(event.DTEND ?? '')
  if (checkIn === null || checkOut === null) return null

  const description = event.DESCRIPTION ?? ''

  return {
    rowNumber,
    cells: {
      UID: event.UID ?? '',
      SUMMARY: event.SUMMARY ?? '',
      DESCRIPTION: description,
      // Already ISO. See the header on why nothing is subtracted from DTEND.
      DTSTART: checkIn,
      DTEND: checkOut,
      LOCATION: event.LOCATION ?? '',
      STATUS: event.STATUS ?? '',
      GUEST_NAME: guestNameFrom(description) ?? '',
      // The unit the operator chose on the upload screen. A calendar is one
      // unit's calendar and the file never says which — the URL did.
      UNIT: unitName !== '' ? unitName : (event.LOCATION ?? ''),
    },
  }
}
