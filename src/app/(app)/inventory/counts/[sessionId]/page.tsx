import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import {
  COUNT_SESSION_STATUS_HELP,
  COUNT_SESSION_STATUS_LABEL,
} from '@/lib/inventory/counts'

import { shellContext } from '../../../_lib/context'
import { requireGrant } from '../../../_lib/guard'
import { ModuleOff } from '../../_components/module-state'
import { CountSheetTable } from '../_components/count-sheet'
import {
  NotProvisioned,
  SessionNotFound,
  SessionNotReadable,
} from '../_components/notices'
import { SessionActions } from '../_components/session-actions'
import { sheetState } from '../_lib/queries'

export const metadata: Metadata = { title: 'גיליון ספירה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The counting sheet itself.
 *
 * THE EXPECTED QUANTITY IS NOT ON THIS PAGE, AND WAS NOT LOADED. For a blind
 * session `sheetState` takes the branch that never reads
 * `inventory_count_expectations` — so the number is not fetched and hidden,
 * not passed and suppressed, not present in the HTML for somebody to find in
 * a developer console. It is absent.
 *
 * That is the difference between a blind count and a count with the answer in
 * a `display: none`. A stocktake that shows the expected figure gets that
 * figure back: people write down what they were shown and stop looking, and
 * the count then proves nothing at all.
 *
 * A READER SEES THE SHEET AND CANNOT WRITE ON IT. `inventory.view` is enough
 * to look; recording a number needs `inventory.adjust`, checked here, in the
 * Server Action, in the operation, and again by row level security.
 */
export default async function CountSheetPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = await params

  const [actor, context] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const state = await sheetState({ actor, context, sessionId })

  if (state.kind === 'module_off') {
    return (
      <ModuleOff
        provisioned={state.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const shell = (body: React.ReactNode) => (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {body}
    </div>
  )

  if (state.kind === 'not_provisioned') return shell(<NotProvisioned />)
  if (state.kind === 'not_found') return shell(<SessionNotFound />)
  if (state.kind === 'not_readable') return shell(<SessionNotReadable />)

  const { session, sheet } = state
  const counted = sheet.lines.filter((line) => line.counted !== null).length

  return shell(
    <>
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {session.label ?? 'ספירת מלאי'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {state.propertyName ?? session.propertyId} ·{' '}
          {COUNT_SESSION_STATUS_LABEL[session.status]} ·{' '}
          {session.blind ? 'ספירה עיוורת' : 'ספירה גלויה'}
        </p>
        <p className="max-w-prose text-muted-foreground">
          {COUNT_SESSION_STATUS_HELP[session.status]}
        </p>
      </header>

      {session.blind && (
        <p className="max-w-prose rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          הגיליון הזה אינו כולל את הכמות שהמערכת מכירה, וגם לא נטען ממנה דבר.
          ספרו את מה שיש על המדף ורשמו אותו. ההשוואה נעשית אחר כך, מול צילום
          שנלקח לפני שהספירה התחילה.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        נספרו {counted} מתוך {sheet.lines.length} פריטים.
      </p>

      {/*
        Only the two stages this screen can honestly act on. Closing belongs
        to the reconciliation screen, which is the one that knows how many
        differences are still unexplained — offering "close" here would ask a
        person to end a stocktake without showing them what it found.
      */}
      {state.mayCount &&
        (session.status === 'open' || session.status === 'counting') && (
          <SessionActions
            sessionId={session.id}
            status={session.status}
            blind={session.blind}
            unexplained={0}
          />
        )}

      <CountSheetTable
        sessionId={session.id}
        sheet={sheet}
        mayCount={state.mayCount}
        open={session.status === 'counting'}
      />

      {(session.status === 'reconciling' || session.status === 'closed') && (
        <div>
          <Button
            href={`/inventory/counts/${session.id}/reconcile`}
            variant="secondary"
          >
            להפרשים ולסיווגם
          </Button>
        </div>
      )}
    </>,
  )
}
