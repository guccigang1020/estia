/**
 * What an error is allowed to say to a user.
 *
 * The charter's rule is that a failure message states three things: what
 * failed, whether the data was saved, and whether trying again is safe. A bare
 * "משהו השתבש" is a refusal to answer any of the three, and it is banned here
 * by construction — every kind below carries all three answers, so a caller
 * cannot accidentally produce one.
 *
 * This file is deliberately plain TypeScript with no JSX. The wording rules are
 * the part that can be wrong in a way a screenshot will not reveal, so they are
 * unit-tested in `error-copy.test.ts`; the component is only a renderer.
 *
 * Division of labour with `src/lib/errors`, which owns the same three questions
 * on the server: a failure that reached a server produces a `SafeErrorBody`
 * with the Hebrew sentences already decided, and `fromSafeError` below adopts
 * them verbatim rather than deriving a second set. `describeError` covers what
 * a server never sees — an unreachable network, a response that never arrived,
 * a client-side render crash.
 */

import type { SafeErrorBody } from '@/lib/errors/safe-response'

/** The failure classes the product can actually distinguish. */
export type ErrorKind =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'quota'
  | 'rate_limited'
  | 'server'
  | 'unknown'

/** Whether the user's work survived. Never omitted, never guessed silently. */
export type DataOutcome = 'not_saved' | 'saved' | 'partial' | 'unknown'

/**
 * Whether pressing the button again is safe.
 *
 * `unsafe` does not mean "hide the button" — it means the user must be told
 * that a second attempt can duplicate a real business effect before they press
 * it. `will_not_help` means retrying cannot succeed until something else
 * changes, so offering a retry would be a lie.
 */
export type RetrySafety = 'safe' | 'unsafe' | 'will_not_help'

export type ErrorDescriptor = {
  kind?: ErrorKind
  /**
   * What the user was trying to do, as a Hebrew infinitive phrase:
   * "לשמור את ההזמנה", "לשלוח את החשבונית". Woven into the description so the
   * message names the actual operation instead of the whole application.
   */
  operation?: string
  /** Overrides the kind's default when the caller genuinely knows better. */
  dataOutcome?: DataOutcome
  /** Overrides the kind's default retry verdict. */
  retry?: RetrySafety
  /** Correlation id or Next.js error digest, for matching the server log. */
  reference?: string
}

export type ErrorPresentation = {
  kind: ErrorKind
  title: string
  description: string
  dataOutcome: DataOutcome
  dataOutcomeText: string
  retry: RetrySafety
  retryText: string
  /** False only when a retry cannot possibly succeed. */
  canRetry: boolean
  /** The label the retry control should carry for this kind. */
  retryLabel: string
  reference?: string
}

type KindCopy = {
  title: string
  /** Used when the caller did not say what the user was doing. */
  description: string
  /** `%s` is replaced by the operation phrase. */
  describeOperation: (operation: string) => string
  dataOutcome: DataOutcome
  retry: RetrySafety
  retryLabel: string
}

const KIND_COPY: Record<ErrorKind, KindCopy> = {
  network: {
    title: 'אין חיבור לשרת',
    description:
      'הבקשה לא יצאה מהמכשיר. בדוק את החיבור לאינטרנט ונסה שוב בעוד רגע.',
    describeOperation: (operation) =>
      `הבקשה ${operation} לא יצאה מהמכשיר. בדוק את החיבור לאינטרנט ונסה שוב בעוד רגע.`,
    dataOutcome: 'not_saved',
    retry: 'safe',
    retryLabel: 'נסה שוב',
  },
  timeout: {
    title: 'השרת לא הגיב בזמן',
    description:
      'הבקשה נשלחה אבל התשובה לא הגיעה. ייתכן שהיא בכל זאת הסתיימה בשרת.',
    describeOperation: (operation) =>
      `הבקשה ${operation} נשלחה אבל התשובה לא הגיעה. ייתכן שהיא בכל זאת הסתיימה בשרת.`,
    dataOutcome: 'unknown',
    retry: 'unsafe',
    retryLabel: 'נסה שוב',
  },
  unauthorized: {
    title: 'החיבור למערכת פג',
    description: 'צריך להתחבר מחדש כדי להמשיך. מה שהוקלד בטופס נשמר במסך.',
    describeOperation: (operation) =>
      `החיבור פג לפני שהספקנו ${operation}. צריך להתחבר מחדש כדי להמשיך.`,
    dataOutcome: 'not_saved',
    retry: 'will_not_help',
    retryLabel: 'התחבר מחדש',
  },
  forbidden: {
    title: 'אין לך הרשאה לפעולה הזאת',
    description:
      'התפקיד שלך בארגון לא כולל את הפעולה. מנהל הארגון יכול להרחיב את ההרשאה.',
    describeOperation: (operation) =>
      `התפקיד שלך בארגון לא מאפשר ${operation}. מנהל הארגון יכול להרחיב את ההרשאה.`,
    dataOutcome: 'not_saved',
    retry: 'will_not_help',
    retryLabel: 'חזור',
  },
  not_found: {
    title: 'הפריט לא נמצא',
    description: 'ייתכן שהוא נמחק, או שהקישור מפנה לפריט של ארגון אחר.',
    describeOperation: (operation) =>
      `לא הצלחנו ${operation}: הפריט לא נמצא. ייתכן שהוא נמחק, או שהקישור מפנה לפריט של ארגון אחר.`,
    dataOutcome: 'not_saved',
    retry: 'will_not_help',
    retryLabel: 'חזור',
  },
  conflict: {
    title: 'מישהו אחר עדכן את הרשומה לפניך',
    description:
      'השינויים שלך לא נדרסו על השינויים שלו. טען מחדש כדי לראות את המצב העדכני, ואז החל שוב את מה שרצית לשנות.',
    describeOperation: (operation) =>
      `רשומה זו השתנתה אחרי שפתחת אותה, ולכן לא היה אפשר ${operation}. טען מחדש כדי לראות את המצב העדכני, ואז החל שוב את השינוי.`,
    dataOutcome: 'not_saved',
    retry: 'will_not_help',
    retryLabel: 'טען מחדש',
  },
  validation: {
    title: 'חלק מהפרטים לא תקינים',
    description: 'השדות המסומנים בטופס מסבירים מה צריך לתקן.',
    describeOperation: (operation) =>
      `לא היה אפשר ${operation} כי חלק מהפרטים לא תקינים. השדות המסומנים בטופס מסבירים מה צריך לתקן.`,
    dataOutcome: 'not_saved',
    retry: 'will_not_help',
    retryLabel: 'חזור לטופס',
  },
  quota: {
    title: 'חרגת מהמכסה של החבילה',
    description:
      'החבילה הנוכחית לא מכסה את הכמות הזאת. שדרוג חבילה יפתח את הפעולה מיד.',
    describeOperation: (operation) =>
      `החבילה הנוכחית לא מאפשרת ${operation} מעבר למכסה. שדרוג חבילה יפתח את הפעולה מיד.`,
    dataOutcome: 'not_saved',
    retry: 'will_not_help',
    retryLabel: 'צפה בחבילות',
  },
  rate_limited: {
    title: 'יותר מדי בקשות ברצף',
    description: 'המערכת עצרה את הקצב לרגע. המתן כמה שניות ונסה שוב.',
    describeOperation: (operation) =>
      `המערכת עצרה את הקצב לרגע ולכן לא ניתן ${operation} כרגע. המתן כמה שניות ונסה שוב.`,
    dataOutcome: 'not_saved',
    retry: 'safe',
    retryLabel: 'נסה שוב',
  },
  server: {
    title: 'השרת נתקל בתקלה',
    description:
      'התקלה נרשמה אצלנו עם מזהה, ואפשר לאתר בדיוק מה קרה. אין צורך לדווח ידנית.',
    describeOperation: (operation) =>
      `השרת נתקל בתקלה בזמן שניסה ${operation}. התקלה נרשמה אצלנו עם מזהה, ואין צורך לדווח עליה ידנית.`,
    dataOutcome: 'unknown',
    retry: 'unsafe',
    retryLabel: 'נסה שוב',
  },
  unknown: {
    title: 'הפעולה נכשלה',
    description:
      'לא הצלחנו לסווג את התקלה, ולכן אנחנו לא מתיימרים לדעת יותר ממה שכתוב כאן.',
    describeOperation: (operation) =>
      `לא הצלחנו ${operation}, ואת סיבת הכשל לא הצלחנו לסווג.`,
    dataOutcome: 'unknown',
    retry: 'unsafe',
    retryLabel: 'נסה שוב',
  },
}

const DATA_OUTCOME_TEXT: Record<DataOutcome, string> = {
  not_saved: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
  saved: 'הנתונים כן נשמרו. הכשל קרה אחרי השמירה, ולכן אין צורך להזין שוב.',
  partial:
    'חלק מהנתונים נשמרו. פתח את הרשומה ובדוק מה נקלט לפני שתנסה שוב, כדי לא ליצור כפילות.',
  unknown:
    'לא ידוע אם הנתונים נשמרו. בדוק את הרשומה לפני ניסיון נוסף, כדי לא ליצור כפילות.',
}

const RETRY_TEXT: Record<RetrySafety, string> = {
  safe: 'ניסיון חוזר בטוח — הוא לא ייצור רשומה כפולה ולא יחייב פעמיים.',
  unsafe:
    'ניסיון חוזר עלול ליצור כפילות. בדוק קודם אם הפעולה בכל זאת בוצעה, ורק אז נסה שוב.',
  will_not_help: 'ניסיון חוזר לא יעזור עד שהסיבה שלמעלה תטופל.',
}

/**
 * Turns everything the caller knows into the three sentences a user is owed.
 *
 * Nothing here invents certainty: when the caller does not state a data
 * outcome, the kind's honest default is used, and `unknown` is a legitimate
 * answer that says so out loud rather than staying silent.
 */
export function describeError(
  descriptor: ErrorDescriptor = {},
): ErrorPresentation {
  const kind = descriptor.kind ?? 'unknown'
  const copy = KIND_COPY[kind]
  const dataOutcome = descriptor.dataOutcome ?? copy.dataOutcome
  const retry = descriptor.retry ?? copy.retry

  return {
    kind,
    title: copy.title,
    description: descriptor.operation
      ? copy.describeOperation(descriptor.operation)
      : copy.description,
    dataOutcome,
    dataOutcomeText: DATA_OUTCOME_TEXT[dataOutcome],
    retry,
    retryText: RETRY_TEXT[retry],
    canRetry: retry !== 'will_not_help',
    retryLabel: copy.retryLabel,
    reference: descriptor.reference,
  }
}

/* ------------------------------------------ the bridge from the server -- */

/**
 * The domain layer already answered these questions.
 *
 * `src/lib/errors` produces a `SafeErrorBody` carrying the user-facing
 * sentence, the data-outcome sentence and the retry sentence, all in Hebrew and
 * all decided server-side. Re-deriving them here from the status code would be
 * a second answer to the same question, and the two would disagree within a
 * month — so this adapter takes the server's wording verbatim and adds only
 * what a server has no opinion about: the headline and the button label.
 *
 * `describeError` above therefore covers what the server never sees — an
 * unreachable network, a timeout with no response, a client-side render crash.
 *
 * The import is type-only, so no domain code is pulled into the client bundle.
 */
export function fromSafeError(
  body: Pick<
    SafeErrorBody,
    | 'code'
    | 'message'
    | 'dataMessage'
    | 'dataOutcome'
    | 'retryMessage'
    | 'retryable'
    | 'correlationId'
  >,
): ErrorPresentation {
  const kind = SERVER_CODE_KIND[body.code] ?? 'unknown'
  const retry: RetrySafety = body.retryable ? 'safe' : 'will_not_help'

  return {
    kind,
    title: KIND_COPY[kind].title,
    description: body.message,
    dataOutcome: body.dataOutcome,
    dataOutcomeText: body.dataMessage,
    retry,
    retryText: body.retryMessage,
    canRetry: body.retryable,
    retryLabel: KIND_COPY[kind].retryLabel,
    reference: body.correlationId,
  }
}

/** Stable server codes, which is what the interface is meant to switch on. */
const SERVER_CODE_KIND: Record<string, ErrorKind> = {
  validation_failed: 'validation',
  not_found: 'not_found',
  version_conflict: 'conflict',
  quota_exceeded: 'quota',
  external_service_failed: 'server',
  idempotency_conflict: 'conflict',
  internal_error: 'server',
  membership_not_active: 'forbidden',
  missing_permission: 'forbidden',
  plan_does_not_include: 'quota',
  out_of_scope: 'forbidden',
}

/** Maps an HTTP status onto the kind the user should be told about. */
export function errorKindFromStatus(status: number): ErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 402 || status === 413) return 'quota'
  if (status === 422 || status === 400) return 'validation'
  if (status === 429) return 'rate_limited'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500) return 'server'
  return 'unknown'
}

const STACK_FRAME = /^\s*(at\s|[\w$.]+@)/

/**
 * The only thing allowed into the collapsed technical block.
 *
 * A stack trace tells a guesthouse owner nothing and tells an attacker
 * something, so frames are dropped rather than merely hidden behind a
 * disclosure. What survives is the first message line plus the reference the
 * support conversation actually needs.
 */
export function technicalDetail(
  error: unknown,
  reference?: string,
): string | undefined {
  const lines: string[] = []
  const message = extractMessage(error)

  if (message) lines.push(message)
  if (reference) lines.push(`מזהה תקלה: ${reference}`)

  return lines.length > 0 ? lines.join('\n') : undefined
}

function extractMessage(error: unknown): string | undefined {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : isMessageBearing(error)
          ? error.message
          : undefined

  if (raw === undefined) return undefined

  // A message can itself carry an appended trace; keep only leading prose.
  const prose = raw
    .split('\n')
    .filter((line) => !STACK_FRAME.test(line))
    .join(' ')
    .trim()

  if (prose.length === 0) return undefined

  return prose.length > 300 ? `${prose.slice(0, 300)}…` : prose
}

function isMessageBearing(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  )
}
