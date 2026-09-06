/**
 * WHAT THIS PROPERTY'S GUIDE IS MISSING.
 *
 * The single most predictable message a guesthouse receives is "מה הסיסמה של
 * הוויי-פיי". The second is "איך נכנסים". Both are answerable in advance, both
 * are answered in the guide, and both are asked anyway — because nobody told
 * the operator the entry was not there.
 *
 * So this file is most of the feature's value, and it is not a score. There is
 * no percentage, no grade and no "your guide is 74% complete", for the reason
 * `src/lib/website/quality.ts` gives about its own passes: a number invites
 * somebody to raise it, and what is wanted is for somebody to write the wi-fi
 * entry. Every finding names one topic, says what a guest will ask without it,
 * and is closed by writing that entry.
 *
 * ── Three severities and what separates them ──────────────────────────────
 *
 * `essential` is a question a guest will certainly ask on a stay this property
 * actually sells. `expected` is one they will probably ask. `optional` is a
 * topic the property has an amenity for and no words about — this module
 * cannot know whether there is a jacuzzi, so it never reports one of those as
 * missing unless the operator has said the property has it.
 *
 * ── An empty entry is a missing entry ─────────────────────────────────────
 *
 * A `wifi` entry whose body is a blank Hebrew string satisfies every
 * constraint and answers nobody, and an operator who created it will believe
 * the topic is covered. So `present` here means "has a non-blank body, or a
 * secret, or a photograph, or a link" — something a guest can actually read —
 * and a heading with nothing under it is reported as loudly as no entry at all.
 *
 * ── A sensitive entry with no secret attached ─────────────────────────────
 *
 * Its own finding, and the one an operator is most grateful for. An `access`
 * entry marked as carrying a code, released after the deposit, with no code
 * behind it, is a guest who pays a deposit and is shown a heading. Nothing
 * else in the product would ever notice.
 */

import {
  GUIDE_TOPICS,
  TOPIC_DEFAULT_STAGE,
  languagesOf,
  type GuideEntry,
  type GuideLanguage,
  type GuideRecommendation,
  type GuideStage,
  type GuideTopic,
} from './types'

/* ------------------------------------------------------------ severity -- */

export const GAP_SEVERITIES = ['essential', 'expected', 'optional'] as const
export type GapSeverity = (typeof GAP_SEVERITIES)[number]

/**
 * The topics a guest asks about on every stay, everywhere.
 *
 * Five, and the list is short on purpose. A checklist long enough to feel
 * thorough is a checklist an operator dismisses whole, and the point is that
 * every line on this one is a message somebody would otherwise send.
 */
export const ESSENTIAL_TOPICS: readonly GuideTopic[] = [
  'wifi',
  'directions',
  'access',
  'check_in_time',
  'checkout',
]

/** Asked often enough to be worth writing once. */
export const EXPECTED_TOPICS: readonly GuideTopic[] = [
  'parking',
  'emergency_contact',
  'air_conditioning',
  'waste',
  'quiet_hours',
]

/**
 * Topics that only matter when the property has the thing.
 *
 * Reported only for topics the caller declares — see `GuideCompletenessInput.
 * amenityTopics`. This module has no opinion about whether there is a pool,
 * and inventing one would produce a finding an operator cannot close.
 */
export const AMENITY_TOPICS: readonly GuideTopic[] = [
  'pool',
  'jacuzzi',
  'barbecue',
  'kitchen',
  'tv',
  'hot_water',
  'shabbat_equipment',
]

/* ------------------------------------------------------------- findings -- */

export const GAP_KINDS = [
  'topic_missing',
  'entry_empty',
  'secret_missing',
  'translation_missing',
  'media_alt_missing',
  'no_recommendations',
] as const
export type GapKind = (typeof GAP_KINDS)[number]

/**
 * One thing to fix.
 *
 * `topic` is the anchor: the settings screen links straight to that topic's
 * editor, so a finding is one click from being closed. A finding a person
 * cannot act on from where they read it is a finding they read twice and then
 * stop reading.
 */
export type GuideGap = {
  kind: GapKind
  severity: GapSeverity
  topic: GuideTopic | null
  stage: GuideStage | null
  /** The entry the finding is about, when it is about one. */
  entryId: string | null
  /** What a guest will ask, or what they will be shown. Hebrew. */
  detail: string
}

export type GuideCompleteness = {
  gaps: readonly GuideGap[]
  /** Counted per severity so a screen can lead with the number that matters. */
  counts: Readonly<Record<GapSeverity, number>>
  /** Topics that have a readable entry. What is already done. */
  covered: readonly GuideTopic[]
}

export type GuideCompletenessInput = {
  entries: readonly GuideEntry[]
  recommendations: readonly GuideRecommendation[]
  /**
   * The entry ids that actually have a secret row behind them.
   *
   * Ids, never values. This function decides whether a code exists; it has no
   * business knowing what it is, and a signature that took secrets would be a
   * second place a code could be handled.
   */
  entryIdsWithSecret: readonly string[]
  /**
   * Topics the property has the amenity for. Stated by the operator.
   */
  amenityTopics?: readonly GuideTopic[]
  /**
   * The languages this property says it offers. Hebrew is not reported —
   * `LocalizedText` already guarantees it.
   */
  languages?: readonly GuideLanguage[]
}

/* ---------------------------------------------------------------- rules -- */

/**
 * Does this entry say anything to a guest?
 *
 * A body, a secret behind it, a photograph or a link. A title alone is a
 * heading, and a heading is what an operator sees when they believe the topic
 * is covered — see the module header.
 */
function isReadable(entry: GuideEntry): boolean {
  const body = entry.body
  if (body !== null && body.he.trim().length > 0) return true
  if (entry.hasSecret) return true
  if (entry.media.length > 0) return true
  if (entry.link !== null) return true
  return false
}

function detailForTopic(topic: GuideTopic): string {
  return TOPIC_QUESTION[topic]
}

/**
 * What a guest asks when the topic is missing, in their words.
 *
 * The wording is the finding. "אין ערך wifi" tells an operator a row is
 * absent; "אורחים ישאלו מה הסיסמה של הוויי-פיי" tells them what happens at
 * 22:00 tonight, and that is the sentence that gets the entry written.
 */
const TOPIC_QUESTION: Readonly<Record<GuideTopic, string>> = Object.freeze({
  directions: 'אורחים ישאלו איך מגיעים, ויתקשרו כשהם כבר בדרך.',
  parking: 'אורחים ישאלו איפה חונים, בדרך כלל כשהם כבר עומדים ברחוב.',
  check_in_time: 'אורחים ישאלו משעה כמה אפשר להיכנס.',
  what_to_bring: 'אורחים ישאלו אם צריך להביא מצעים, מגבות או אוכל.',
  arrival_contact: 'אורחים ישאלו למי מתקשרים כשמשהו משתבש בהגעה.',
  wifi: 'אורחים ישאלו מה הסיסמה של הוויי-פיי. זו השאלה הנפוצה ביותר.',
  access: 'אורחים ישאלו איך נכנסים — קוד, מפתח או מי פותח.',
  pool: 'אורחים ישאלו על שעות הבריכה ועל כללי השימוש בה.',
  jacuzzi: 'אורחים ישאלו איך מפעילים את הג׳קוזי וכמה זמן לוקח לו להתחמם.',
  air_conditioning: 'אורחים ישאלו איך מפעילים את המזגן.',
  tv: 'אורחים ישאלו איך מפעילים את הטלוויזיה ואיזה שלט שייך למה.',
  barbecue: 'אורחים ישאלו אם מותר לעשות על האש ואיפה.',
  hot_water: 'אורחים ישאלו למה אין מים חמים ומתי הדוד עובד.',
  kitchen: 'אורחים ישאלו מה יש במטבח ומה מותר להשתמש בו.',
  shabbat_equipment: 'אורחים ישאלו על פלטה, מיחם ושעון שבת.',
  quiet_hours: 'שכנים יתלוננו על רעש בשעות שאיש לא סיכם עם האורחים.',
  waste: 'אורחים ישאלו איפה זורקים את הזבל, ובדרך כלל אחרי שכבר לא שאלו.',
  emergency_contact: 'אורחים ישאלו למי מתקשרים באמצע הלילה.',
  checkout: 'אורחים ישאלו עד מתי לפנות ומה צריך לעשות לפני שיוצאים.',
  forgotten_items: 'אורחים ישאלו מה קורה עם מה ששכחו, אחרי שכבר עזבו.',
  feedback: 'אורחים לא ישאלו — הם פשוט לא יכתבו ביקורת.',
  custom: 'תוכן שהבית הזה הגדיר בעצמו.',
})

/* --------------------------------------------------------------- report -- */

/**
 * The report, per property.
 *
 * Order matters on screen: essential first, then expected, then optional, and
 * within a severity the order of `GUIDE_TOPICS`, which is the order the guide
 * itself is arranged in. An operator reads down the list and works down the
 * guide.
 */
export function guideCompleteness(
  input: GuideCompletenessInput,
): GuideCompleteness {
  const gaps: GuideGap[] = []
  const withSecret = new Set(input.entryIdsWithSecret)
  const amenityTopics = input.amenityTopics ?? []
  const languages = (input.languages ?? []).filter(
    (language) => language !== 'he',
  )

  const active = input.entries.filter((entry) => entry.isActive)
  const byTopic = new Map<GuideTopic, GuideEntry[]>()
  for (const entry of active) {
    const bucket = byTopic.get(entry.topic)
    if (bucket) bucket.push(entry)
    else byTopic.set(entry.topic, [entry])
  }

  const covered: GuideTopic[] = []

  for (const topic of GUIDE_TOPICS) {
    if (topic === 'custom') continue

    const severity = severityOf(topic, amenityTopics)
    if (severity === null) continue

    const entries = byTopic.get(topic) ?? []
    const readable = entries.filter(isReadable)

    if (readable.length > 0) {
      covered.push(topic)
      continue
    }

    gaps.push({
      // An entry that exists and says nothing is a different problem from one
      // that was never created, and it is fixed differently: one is "write
      // the text", the other is "add the entry".
      kind: entries.length > 0 ? 'entry_empty' : 'topic_missing',
      severity,
      topic,
      stage: TOPIC_DEFAULT_STAGE[topic],
      entryId: entries.length > 0 ? entries[0].id : null,
      detail: detailForTopic(topic),
    })
  }

  // A sensitive entry with nothing behind it. Checked over every active entry
  // rather than per topic, because a property may hold two coded entries — the
  // gate and the flat — and both have to be filled in.
  for (const entry of active) {
    if (entry.hasSecret && !withSecret.has(entry.id)) {
      gaps.push({
        kind: 'secret_missing',
        severity: 'essential',
        topic: entry.topic,
        stage: entry.stage,
        entryId: entry.id,
        detail:
          'הערך מסומן כמכיל קוד או סוד, ולא הוזן ערך. אורח שיעמוד בתנאים ' +
          'יראה כותרת בלי תוכן.',
      })
    }
  }

  // Alt text. A finding rather than a constraint, exactly as `site_media`
  // argues: a business adding photographs at 23:00 must be told, not stopped.
  for (const entry of active) {
    const missing = entry.media.filter((item) => item.altText === null)
    if (missing.length > 0) {
      gaps.push({
        kind: 'media_alt_missing',
        severity: 'optional',
        topic: entry.topic,
        stage: entry.stage,
        entryId: entry.id,
        detail:
          'לתמונה או לסרטון אין תיאור חלופי. אורח שמשתמש בקורא מסך לא יקבל ' +
          'ממנה דבר.',
      })
    }
  }

  // Translations, only for languages the property said it offers. Reporting a
  // missing English body for a house that serves Hebrew speakers would be a
  // finding nobody should close.
  for (const language of languages) {
    const untranslated = active.filter(
      (entry) => !languagesOf(entry.title).includes(language),
    )
    if (untranslated.length > 0) {
      gaps.push({
        kind: 'translation_missing',
        severity: 'expected',
        topic: null,
        stage: null,
        entryId: null,
        detail:
          `${untranslated.length} ערכים אינם מתורגמים לשפה שהנכס הצהיר ` +
          'עליה. אורח שיבחר בה יקבל את הטקסט בעברית.',
      })
    }
  }

  if (input.recommendations.filter((item) => item.isActive).length === 0) {
    gaps.push({
      kind: 'no_recommendations',
      severity: 'optional',
      topic: null,
      stage: null,
      entryId: null,
      detail:
        'אין המלצות מקומיות. אורחים ישאלו איפה אוכלים, ותשובה כתובה מראש ' +
        'שווה יותר מהמלצה שנמסרת בטלפון בשבע בערב.',
    })
  }

  return {
    gaps: sortGaps(gaps),
    counts: tally(gaps),
    covered,
  }
}

function severityOf(
  topic: GuideTopic,
  amenityTopics: readonly GuideTopic[],
): GapSeverity | null {
  if (ESSENTIAL_TOPICS.includes(topic)) return 'essential'
  if (EXPECTED_TOPICS.includes(topic)) return 'expected'
  if (AMENITY_TOPICS.includes(topic)) {
    return amenityTopics.includes(topic) ? 'optional' : null
  }
  // `forgotten_items`, `feedback`, `what_to_bring`, `arrival_contact` and the
  // rest: worth having, never urgent.
  return 'optional'
}

const SEVERITY_ORDER: readonly GapSeverity[] = [
  'essential',
  'expected',
  'optional',
]

function sortGaps(gaps: readonly GuideGap[]): readonly GuideGap[] {
  return [...gaps].sort((a, b) => {
    const severity =
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    if (severity !== 0) return severity

    const topicA = a.topic === null ? GUIDE_TOPICS.length : indexOf(a.topic)
    const topicB = b.topic === null ? GUIDE_TOPICS.length : indexOf(b.topic)
    return topicA - topicB
  })
}

function indexOf(topic: GuideTopic): number {
  return GUIDE_TOPICS.indexOf(topic)
}

function tally(
  gaps: readonly GuideGap[],
): Readonly<Record<GapSeverity, number>> {
  const counts: Record<GapSeverity, number> = {
    essential: 0,
    expected: 0,
    optional: 0,
  }
  for (const gap of gaps) counts[gap.severity] += 1
  return counts
}

/**
 * Is anything here worth interrupting somebody about?
 *
 * True only for `essential`. A settings screen that shouted about a missing
 * alt text would be a screen an operator stops reading, and the wi-fi entry
 * would still be missing.
 */
export function needsAttention(report: GuideCompleteness): boolean {
  return report.counts.essential > 0
}
