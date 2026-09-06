/**
 * What the accounting connection is, said without apology.
 *
 * ── "Not connected" is a configuration, not a failure ─────────────────────
 *
 * Most of the businesses this product is for issue their documents in a
 * separate accounting system and always will. `settings/payments/page.tsx`
 * makes the same argument about card processing and builds its screen for the
 * business that takes no cards; this panel is built for the business that
 * connects no invoicing vendor. There is no red banner, no "setup incomplete",
 * no disabled integration tile implying a step was skipped. It says what is
 * true and what the business can do, and both sentences are ordinary.
 *
 * No `"use client"`: it renders text.
 */

import { FactRow, PanelNote } from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { NOT_CONFIGURED_REASON, NULL_FISCAL_PROVIDER } from '@/lib/fiscal'

export type ProviderStatusProps = {
  provider: string
  documentsExpected: boolean
  capabilities: readonly string[]
  connectedAt: Date | null
}

export function ProviderStatus({
  provider,
  documentsExpected,
  capabilities,
  connectedAt,
}: ProviderStatusProps) {
  const connected = provider !== NULL_FISCAL_PROVIDER

  return (
    <div className="flex flex-col gap-5">
      <dl className="flex flex-col">
        <FactRow label="ספק הפקת מסמכים">
          {connected ? (
            <span dir="ltr" className="font-mono text-xs">
              {provider}
            </span>
          ) : (
            <Badge tone="neutral">לא מחובר</Badge>
          )}
        </FactRow>

        <FactRow label="האם המערכת מפיקה מסמכים חשבונאיים">
          {documentsExpected ? 'כן' : 'לא — המסמכים מופקים מחוץ למערכת'}
        </FactRow>

        {connected && (
          <FactRow label="מחובר מאז">
            {connectedAt === null
              ? '—'
              : connectedAt.toLocaleDateString('he-IL')}
          </FactRow>
        )}
      </dl>

      {connected && capabilities.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            מה הספק המחובר יודע לעשות
          </h3>
          {/*
           * Listed rather than assumed. Vendors differ in ways that change what
           * the product can offer — one issues a combined tax-invoice-receipt
           * and another does not — and a screen that hid that would let a
           * business discover it at the worst moment.
           */}
          <ul className="flex flex-wrap gap-1.5">
            {capabilities.map((capability) => (
              <li key={capability}>
                <Badge tone="brand" className="font-mono" dir="ltr">
                  {capability}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!connected && <PanelNote>{NOT_CONFIGURED_REASON}</PanelNote>}
    </div>
  )
}
