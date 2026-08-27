/**
 * EXECUTION CONTEXT — either. Pure data and string mapping, no client.
 *
 * Supabase error code -> the Hebrew sentence the person actually needs.
 *
 * The rule this file exists to enforce: never say "משהו השתבש" when we know
 * more than that. A wrong password, an unconfirmed address and a rate limit
 * are three different problems with three different next steps, and collapsing
 * them into one apology turns a ten-second fix into a support ticket.
 *
 * The codes are the `ErrorCode` union from
 * `node_modules/@supabase/auth-js/dist/module/lib/error-codes.d.ts`. Codes not
 * listed here fall back to a generic sentence — the server logs the real code
 * so the gap is visible in logs rather than in front of the user.
 *
 * ACCOUNT ENUMERATION
 * -------------------
 * Some of these sentences confirm that an address exists. That is only safe
 * where the caller has already proved they hold the credential:
 *
 *   `email_not_confirmed` is returned by GoTrue only AFTER the password has
 *   verified, so whoever sees it already knew the account existed.
 *
 * The passwordless paths are the dangerous ones, and they never reach this
 * map: forgot-password and magic-link return one fixed neutral sentence for
 * every outcome. See `src/app/(auth)/actions.ts`.
 */

const MESSAGES: Record<string, string> = {
  // ── Credentials ──────────────────────────────────────────────────────────
  // Deliberately identical for "no such user" and "wrong password".
  invalid_credentials: 'האימייל או הסיסמה שגויים. בדקו ונסו שוב.',
  email_not_confirmed:
    'הסיסמה נכונה, אבל כתובת האימייל עדיין לא אומתה. פתחו את הקישור ששלחנו לכם במייל, או בקשו קישור חדש.',
  user_banned: 'הגישה לחשבון הזה הושעתה. פנו למנהל הארגון שלכם.',

  // ── Registration ─────────────────────────────────────────────────────────
  signup_disabled: 'ההרשמה סגורה כרגע. פנו אלינו ונפתח לכם חשבון.',
  email_provider_disabled: 'הרשמה עם אימייל אינה זמינה כרגע.',
  email_address_invalid: 'כתובת האימייל אינה תקינה.',
  email_address_not_authorized: 'לא ניתן לשלוח דואר לכתובת הזו.',
  validation_failed: 'אחד הפרטים שהוזנו אינו תקין. בדקו ונסו שוב.',

  // ── Passwords ────────────────────────────────────────────────────────────
  weak_password:
    'הסיסמה חלשה מדי. בחרו סיסמה באורך 8 תווים לפחות, עם אותיות ומספרים.',
  same_password: 'הסיסמה החדשה זהה לסיסמה הנוכחית. בחרו סיסמה אחרת.',
  reauthentication_needed: 'לצורך שינוי הסיסמה יש להתחבר מחדש.',

  // ── Links that no longer work ────────────────────────────────────────────
  otp_expired:
    'הקישור פג תוקף או שכבר נעשה בו שימוש. בקשו קישור חדש — הקישורים תקפים לזמן מוגבל, פעם אחת.',
  otp_disabled: 'הכניסה באמצעות קישור אינה זמינה כרגע.',
  flow_state_expired:
    'הקישור כבר אינו תקף. בקשו קישור חדש והשלימו את הכניסה באותו דפדפן.',
  flow_state_not_found:
    'לא הצלחנו להשלים את הכניסה. ייתכן שהקישור נפתח בדפדפן אחר מזה שממנו ביקשתם אותו. בקשו קישור חדש.',
  bad_code_verifier:
    'לא הצלחנו להשלים את הכניסה. פתחו את הקישור באותו דפדפן שממנו ביקשתם אותו, או בקשו קישור חדש.',
  bad_jwt: 'פג תוקף החיבור. היכנסו שוב.',
  session_not_found: 'פג תוקף החיבור. היכנסו שוב.',
  session_expired: 'פג תוקף החיבור. היכנסו שוב.',
  refresh_token_not_found: 'פג תוקף החיבור. היכנסו שוב.',
  refresh_token_already_used: 'פג תוקף החיבור. היכנסו שוב.',

  // ── Rate limiting ────────────────────────────────────────────────────────
  over_request_rate_limit:
    'נשלחו יותר מדי בקשות מהמחשב הזה. המתינו כדקה ונסו שוב.',
  over_email_send_rate_limit:
    'נשלחו כבר כמה הודעות לכתובת הזו. המתינו כמה דקות לפני בקשה נוספת — בדקו בינתיים גם בתיקיית הספאם.',

  // ── Infrastructure ───────────────────────────────────────────────────────
  request_timeout: 'הבקשה ארכה זמן רב מדי. נסו שוב בעוד רגע.',
  captcha_failed: 'אימות האבטחה נכשל. רעננו את הדף ונסו שוב.',
  conflict: 'הפעולה התנגשה בפעולה מקבילה. נסו שוב.',
}

const GENERIC = 'לא הצלחנו להשלים את הפעולה. נסו שוב בעוד רגע.'

const OFFLINE = 'אין כרגע חיבור לשרת ההזדהות. בדקו את החיבור לאינטרנט ונסו שוב.'

type MaybeAuthError = {
  code?: string | null
  name?: string
  status?: number
  message?: string
}

/**
 * Maps a caught Supabase error to Hebrew. Accepts `unknown` because that is
 * what a `catch` binding is, and because callers should not have to narrow the
 * type before they can show a message.
 */
export function authErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return GENERIC

  const err = error as MaybeAuthError

  // A failed fetch, not a rejected request: the auth server was unreachable.
  if (err.name === 'AuthRetryableFetchError' && !err.status) return OFFLINE

  if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]

  // Older GoTrue responses, and a handful of current ones, carry no `code`.
  if (err.status === 429) return MESSAGES.over_request_rate_limit

  return GENERIC
}

/**
 * Maps a bare code — the kind that arrives as a query parameter on a failed
 * callback redirect, where the original error object is long gone.
 */
export function authErrorMessageForCode(
  code: string | null | undefined,
): string | null {
  if (!code) return null
  return MESSAGES[code] ?? GENERIC
}
