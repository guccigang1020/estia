'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS.
 *
 * Changing which organization or property you are working in.
 *
 * These are POSTs, not links. A GET that changes what the next screen writes
 * to is a CSRF hole — `<img src="/switch?org=…">` on any page would silently
 * move somebody into a different tenant, and the next booking they create
 * would land in the wrong business. Server Actions post with an origin check,
 * which is what makes this the safe shape. The same reasoning is written out
 * on `SignOutButton`, and it applies with more force here.
 *
 * Neither action trusts the submitted id. The organization must be one the
 * database will admit a membership for right now, and the property must be
 * inside the actor's resolved scope. A form value is a request, not a fact.
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

import { resolveActor } from '@/lib/actor'
import { getCurrentUser } from '@/lib/supabase/server'

import { SupabaseActorSource } from './actor-source'
import {
  ALL_PROPERTIES,
  PROPERTY_COOKIE,
  WORKSPACE_COOKIE,
  loadWorkspaces,
} from './context'

/**
 * A year, because a workspace choice is a working habit rather than a session
 * detail. `httpOnly` because nothing in the browser needs to read it and a
 * value the page script cannot touch is one fewer way to end up in the wrong
 * tenant. `sameSite: 'lax'` keeps it off cross-site POSTs.
 */
const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * 365,
} as const

export async function selectWorkspaceAction(formData: FormData): Promise<void> {
  const requested = formData.get('organizationId')
  if (typeof requested !== 'string' || requested === '') return

  const user = await getCurrentUser()
  if (!user) return

  // The authoritative list, re-read now. Row level security answers it, so a
  // membership revoked a second ago is already gone from the answer.
  const workspaces = await loadWorkspaces(user.id)
  if (!workspaces.some((w) => w.organizationId === requested)) return

  const store = await cookies()
  store.set(WORKSPACE_COOKIE, requested, COOKIE_OPTIONS)

  // The property selection belongs to the organization it was made in.
  // Carrying it across is how someone ends up filtered to a property that is
  // not in the business they are now looking at.
  store.set(PROPERTY_COOKIE, ALL_PROPERTIES, COOKIE_OPTIONS)

  // The shell reads both cookies in a layout, so the whole tree has to be
  // re-rendered, not just the page below it.
  revalidatePath('/', 'layout')
}

export async function selectPropertyAction(formData: FormData): Promise<void> {
  const requested = formData.get('propertyId')
  if (typeof requested !== 'string' || requested === '') return

  const store = await cookies()

  if (requested === ALL_PROPERTIES) {
    store.set(PROPERTY_COOKIE, ALL_PROPERTIES, COOKIE_OPTIONS)
    revalidatePath('/', 'layout')
    return
  }

  const user = await getCurrentUser()
  if (!user) return

  const organizationId = store.get(WORKSPACE_COOKIE)?.value
  if (!organizationId) return

  const resolution = await resolveActor(
    new SupabaseActorSource(),
    user.id,
    organizationId,
  )
  if (!resolution.ok) return

  // Only a property this membership is actually scoped to. An organization-wide
  // scope has no property list to choose from yet — see `context.ts` — so it
  // cannot narrow, and an id arriving from a form for such a person is refused
  // rather than stored.
  const { scope } = resolution.actor
  if (scope.kind !== 'properties' || !scope.propertyIds.includes(requested)) {
    return
  }

  store.set(PROPERTY_COOKIE, requested, COOKIE_OPTIONS)
  revalidatePath('/', 'layout')
}
