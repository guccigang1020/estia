import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { Td, Th } from '@/components/operations/table-parts'
import { holdsGrant } from '@/lib/authz/can'
import { localDate } from '@/lib/booking'
import { COUNT_SESSION_STATUS_LABEL } from '@/lib/inventory/counts'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { ModuleOff } from '../_components/module-state'
import { NoSessionsYet, NotProvisioned } from './_components/notices'
import { OpenSessionForm } from './_components/open-session-form'
import { countsState } from './_lib/queries'

export const metadata: Metadata = { title: 'ספירות מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Every stocktake, and the way to start
 * one.
 *
 * WHAT A STOCKTAKE IS FOR, SAID ON THE SCREEN. The ledger is derived from
 * movements and is therefore internally consistent — and internally consistent
 * is not the same as true. A physical count is the only evidence the product
 * ever gets that the two agree, and this screen exists to make taking one
 * cheap enough that a business actually does it.
 *
 * BLIND IS THE DEFAULT AND THE PAGE ARGUES FOR IT. A sheet that shows the
 * expected quantity gets that quantity back. The form says so before the box
 * is unticked rather than after.
 *
 * A COUNT MOVES NOTHING. Not when it is opened, not when a number is written
 * down, not when the differences are listed. Stock moves only when somebody
 * classifies a difference and the classification implies a movement — and
 * ״לא הוסבר״ implies none.
 */
export default async function InventoryCountsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const state = await countsState({ actor, context })

  if (state.kind === 'module_off') {
    return (
      <ModuleOff
        provisioned={state.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          ספירות מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          ספירה פיזית היא הראיה היחידה שהרישום נכון. הספירה עצמה אינה משנה כמות
          — כל שינוי במלאי נובע מסיווג של הפרש, ואחרי הסיווג נשאר תיעוד מלא של
          מה נספר, מתי, ועל ידי מי.
        </p>
      </header>

      {state.kind === 'not_provisioned' ? (
        <NotProvisioned />
      ) : (
        <>
          {state.mayCount && (
            <OpenSessionForm
              properties={context.properties.map((property) => ({
                id: property.id,
                name: property.name ?? property.id,
              }))}
              today={localDate(new Date())}
            />
          )}

          {state.sessions.length === 0 ? (
            <NoSessionsYet mayCount={state.mayCount} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-soft">
              <table className="w-full min-w-[36rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <Th>ספירה</Th>
                    <Th>נכס</Th>
                    <Th>מצב</Th>
                    <Th>סוג</Th>
                    <Th>מועד</Th>
                    <Th>פתיחה</Th>
                  </tr>
                </thead>
                <tbody>
                  {state.sessions.map((session) => (
                    <tr
                      key={session.id}
                      className="border-b border-border last:border-b-0"
                    >
                      <Td>
                        <span className="font-medium text-foreground">
                          {session.label ?? 'ספירה ללא שם'}
                        </span>
                      </Td>
                      <Td>
                        {state.propertyNames.get(session.propertyId) ??
                          session.propertyId}
                      </Td>
                      <Td>{COUNT_SESSION_STATUS_LABEL[session.status]}</Td>
                      <Td>{session.blind ? 'עיוורת' : 'גלויה'}</Td>
                      <Td>{session.scheduledFor ?? '–'}</Td>
                      <Td>
                        <Button
                          href={`/inventory/counts/${session.id}`}
                          variant="secondary"
                          size="sm"
                        >
                          פתח
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
