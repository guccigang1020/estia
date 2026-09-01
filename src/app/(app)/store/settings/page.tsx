import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { StoreLock } from '@/components/store/store-lock'
import { StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { toSafeResponse } from '@/lib/errors'
import { StoreRepository, type StoreSettings } from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'
import { StoreSettingsForm } from './settings-form'

export const metadata: Metadata = { title: 'הגדרות · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The one screen that turns the store on.
 *
 * Gated on `product.manage` rather than `product.view`: reading what you sell
 * and deciding whether you sell at all are different acts, and the second is
 * the owner's. A receptionist who reaches this URL is redirected by the gate
 * before anything is read.
 */
export default async function StoreSettingsPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.manage'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו ההגדרות של החנות — האם היא פעילה, איך משלמים עליה ומה האורח רואה."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let settings: StoreSettings | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    settings = await new StoreRepository(db).settings({
      organizationId: access.actor.organizationId,
      propertyId,
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="הגדרות החנות"
        lead="כמה חנות אתם רוצים להפעיל, ומה האורח רואה."
        action={
          <Link
            href="/store/preview"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground"
          >
            תצוגה מקדימה כאורח
          </Link>
        }
      />
      <StoreNav current="/store/settings" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : settings ? (
        <StoreSettingsForm settings={settings} />
      ) : null}
    </div>
  )
}
