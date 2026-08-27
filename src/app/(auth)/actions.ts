'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Every authentication mutation in ESTIA.
 *
 * Server Actions rather than client-side `fetch`, per
 * `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`.
 * The practical consequences here are worth stating, because they are the
 * reason for the choice:
 *
 *   - The publishable key never has to be exercised from the browser to sign
 *     somebody in, and the session cookie is written by the server that set it.
 *   - The forms submit and work with JavaScript disabled or not yet loaded,
 *     which is the difference between a slow connection being slow and being
 *     broken.
 *
 * The same doc carries the warning that governs everything below: a Server
 * Action is reachable by direct POST, not only through our own UI. Nothing
 * here trusts the shape of its input.
 *
 * ACCOUNT ENUMERATION — the rule for this file
 * --------------------------------------------
 * A stranger must not be able to learn which addresses have accounts.
 *
 *   sign-in           GoTrue answers `invalid_credentials` for both "no such
 *                     user" and "wrong password", so the honest error is
 *                     already the safe one.
 *   sign-up           One neutral sentence whether the address was free or
 *                     already taken. `data.user.identities` reveals which it
 *                     was; it is deliberately never read.
 *   magic link        One neutral sentence, always. Errors that would
 *                     distinguish a missing account — `otp_disabled` when
 *                     `shouldCreateUser` is false — are swallowed.
 *   forgot password   One neutral sentence, always. Supabase already returns
 *                     success for unknown addresses; the swallow below covers
 *                     the cases where it does not.
 *
 * Rate-limit errors ARE surfaced on those paths. They describe the caller's
 * own behaviour, not the target address, so they leak nothing and withholding
 * them just leaves someone re-sending mail into a wall.
 */

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { authErrorMessage } from '@/lib/supabase/auth-errors'
import { createClient } from '@/lib/supabase/server'

import {
  fail,
  hasFieldErrors,
  readSecret,
  readText,
  succeed,
  validateEmail,
  validateNewPassword,
  type AuthField,
  type AuthFormState,
} from './_lib/form-state'
import {
  DEFAULT_AFTER_SIGN_IN,
  safeRedirectTarget,
} from './_lib/redirect-target'

/* --------------------------------------------------------------- helpers -- */

/**
 * The origin to build email links against.
 *
 * KNOWN LIMITATION: this is derived from request headers, which a client
 * controls. The exposure is bounded — Supabase refuses to redirect anywhere
 * outside the project's configured Redirect URL allowlist, so a forged `Host`
 * produces a rejected link rather than a poisoned one — but deriving a
 * security-relevant URL from a request header is the wrong shape. The right
 * fix is a `NEXT_PUBLIC_SITE_URL` entry in `src/lib/env.ts`, which belongs to
 * another engineer; it is raised in the handover notes.
 */
async function siteOrigin(): Promise<string> {
  const headerList = await headers()

  const origin = headerList.get('origin')
  if (origin) return origin

  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  const proto =
    headerList.get('x-forwarded-proto') ??
    (host?.startsWith('localhost') ? 'http' : 'https')

  return `${proto}://${host ?? 'localhost:3000'}`
}

async function callbackUrl(next: string): Promise<string> {
  const origin = await siteOrigin()
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`
}

/**
 * Recovery is marked with its own flag rather than with `next=/reset-password`.
 * `safeRedirectTarget` refuses `/reset-password` as a redirect destination on
 * purpose, so passing the intent through `next` would be stripped in the
 * callback and the recovery session would be delivered to `/account` — a
 * forwarded reset email would then be a live account takeover.
 */
async function recoveryCallbackUrl(): Promise<string> {
  const origin = await siteOrigin()
  return `${origin}/auth/callback?flow=recovery`
}

/**
 * Logged, never shown. The user gets the mapped Hebrew sentence; the operator
 * gets the code, so a message falling through to the generic fallback is
 * visible in logs instead of only in a support call.
 */
function logAuthFailure(action: string, error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : 'unknown'
  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined

  console.warn(`[auth] ${action} failed`, { code, status })
}

/* ------------------------------------------------------------- sign in ---- */

export async function signInAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = readText(formData, 'email').toLowerCase()
  const password = readSecret(formData, 'password')
  const next = safeRedirectTarget(readText(formData, 'next'))

  const fieldErrors: Partial<Record<AuthField, string>> = {}
  const emailError = validateEmail(email)
  if (emailError) fieldErrors.email = emailError
  if (!password) fieldErrors.password = 'יש להזין סיסמה.'

  if (hasFieldErrors(fieldErrors)) {
    return fail(previous, 'בדקו את הפרטים המסומנים ונסו שוב.', fieldErrors)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    logAuthFailure('signIn', error)
    return fail(previous, authErrorMessage(error))
  }

  // The session cookie has changed, so every cached render above it is stale.
  revalidatePath('/', 'layout')
  redirect(next)
}

/* ------------------------------------------------------------- sign up ---- */

export async function signUpAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const fullName = readText(formData, 'fullName')
  const email = readText(formData, 'email').toLowerCase()
  const password = readSecret(formData, 'password')
  const confirmPassword = readSecret(formData, 'confirmPassword')

  const fieldErrors: Partial<Record<AuthField, string>> = {}

  if (!fullName) fieldErrors.fullName = 'יש להזין שם מלא.'
  else if (fullName.length > 120) fieldErrors.fullName = 'השם ארוך מדי.'

  const emailError = validateEmail(email)
  if (emailError) fieldErrors.email = emailError

  const passwordError = validateNewPassword(password)
  if (passwordError) fieldErrors.password = passwordError
  else if (password !== confirmPassword) {
    fieldErrors.confirmPassword = 'שתי הסיסמאות אינן זהות.'
  }

  if (hasFieldErrors(fieldErrors)) {
    return fail(previous, 'בדקו את הפרטים המסומנים ונסו שוב.', fieldErrors)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: await callbackUrl(DEFAULT_AFTER_SIGN_IN),
      // Lands in `auth.users.raw_user_meta_data`. The profile row in
      // `public.user_profiles` is a separate concern and is NOT created here —
      // see the handover notes.
      data: { full_name: fullName },
    },
  })

  if (error) {
    logAuthFailure('signUp', error)
    return fail(previous, authErrorMessage(error))
  }

  // Email confirmation is on for this project, so there is no session yet.
  // If it is ever turned off, Supabase returns one and the user is already in.
  if (data.session) {
    revalidatePath('/', 'layout')
    redirect(DEFAULT_AFTER_SIGN_IN)
  }

  // Neutral by design. `data.user.identities` would say whether the address
  // was already registered; reading it and branching would hand an attacker a
  // membership oracle for the price of one form submission.
  return succeed(
    previous,
    'שלחנו הודעה לכתובת שהזנתם. אם היא עדיין אינה רשומה, ההודעה מכילה קישור להפעלת החשבון. ' +
      'אם לא הגיעה הודעה תוך כמה דקות, בדקו גם בתיקיית דואר הזבל.',
  )
}

/* ---------------------------------------------------------- magic link ---- */

const MAGIC_LINK_SENT =
  'אם קיים חשבון עם הכתובת הזו, שלחנו אליה קישור כניסה. ' +
  'הקישור תקף לשעה, לשימוש אחד, ויש לפתוח אותו באותו דפדפן.'

export async function magicLinkAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = readText(formData, 'email').toLowerCase()
  const next = safeRedirectTarget(readText(formData, 'next'))

  const emailError = validateEmail(email)
  if (emailError) {
    return fail(previous, 'בדקו את הפרטים המסומנים ונסו שוב.', {
      email: emailError,
    })
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Membership in ESTIA is granted by invitation, not claimed by whoever
      // types an address into a login box. A magic link signs an existing
      // account in; it never quietly creates one.
      shouldCreateUser: false,
      emailRedirectTo: await callbackUrl(next),
    },
  })

  if (error) {
    logAuthFailure('magicLink', error)

    // Rate limits describe the caller, not the address, so they are safe to
    // show — and useless to withhold.
    if (
      error.code === 'over_email_send_rate_limit' ||
      error.code === 'over_request_rate_limit' ||
      error.status === 429
    ) {
      return fail(previous, authErrorMessage(error))
    }

    // Everything else is swallowed. `otp_disabled` here means "no account with
    // that address", and saying so out loud is the enumeration hole.
  }

  return succeed(previous, MAGIC_LINK_SENT)
}

/* ------------------------------------------------------ forgot password ---- */

const RESET_LINK_SENT =
  'אם קיים חשבון עם הכתובת הזו, שלחנו אליה קישור לאיפוס הסיסמה. ' +
  'הקישור תקף לשעה, לשימוש אחד, ויש לפתוח אותו באותו דפדפן.'

export async function forgotPasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = readText(formData, 'email').toLowerCase()

  const emailError = validateEmail(email)
  if (emailError) {
    return fail(previous, 'בדקו את הפרטים המסומנים ונסו שוב.', {
      email: emailError,
    })
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // The callback exchanges the code for a short-lived recovery session and
    // then sends the user to the form where they choose a new password.
    redirectTo: await recoveryCallbackUrl(),
  })

  if (error) {
    logAuthFailure('forgotPassword', error)

    if (
      error.code === 'over_email_send_rate_limit' ||
      error.code === 'over_request_rate_limit' ||
      error.status === 429
    ) {
      return fail(previous, authErrorMessage(error))
    }
  }

  // Same sentence whether the address exists, does not exist, or the send
  // failed. Anything else is a membership oracle.
  return succeed(previous, RESET_LINK_SENT)
}

/* ------------------------------------------------------- reset password ---- */

export async function resetPasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = readSecret(formData, 'password')
  const confirmPassword = readSecret(formData, 'confirmPassword')

  const fieldErrors: Partial<Record<AuthField, string>> = {}
  const passwordError = validateNewPassword(password)
  if (passwordError) fieldErrors.password = passwordError
  else if (password !== confirmPassword) {
    fieldErrors.confirmPassword = 'שתי הסיסמאות אינן זהות.'
  }

  if (hasFieldErrors(fieldErrors)) {
    return fail(previous, 'בדקו את הפרטים המסומנים ונסו שוב.', fieldErrors)
  }

  const supabase = await createClient()

  // The recovery link produced a real session. Without one there is nothing to
  // update, and `updateUser` would change the password of whoever IS signed in
  // — so the session is confirmed before the write, not assumed by the page.
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return fail(
      previous,
      'הקישור לאיפוס הסיסמה כבר אינו תקף. בקשו קישור חדש והשלימו את האיפוס תוך שעה.',
    )
  }

  const { error } = await supabase.auth.updateUser({ password })

  if (error) {
    logAuthFailure('resetPassword', error)
    return fail(previous, authErrorMessage(error))
  }

  // A password reset is how someone recovers an account they may have lost
  // control of, so every OTHER session is ended. The one in this browser
  // stays, because the person holding it just proved they own the mailbox.
  const { error: signOutError } = await supabase.auth.signOut({
    scope: 'others',
  })
  if (signOutError) logAuthFailure('resetPassword.signOutOthers', signOutError)

  revalidatePath('/', 'layout')
  redirect(`${DEFAULT_AFTER_SIGN_IN}?notice=password-updated`)
}

/* ------------------------------------------------------------ sign out ---- */

export async function signOutAction(): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase.auth.signOut()
  if (error) logAuthFailure('signOut', error)

  // Sign-out proceeds regardless. If the token was already invalid the server
  // call fails, and refusing to clear the cookie would strand the user in a
  // session they cannot use and cannot leave.
  revalidatePath('/', 'layout')
  redirect('/sign-in?notice=signed-out')
}
