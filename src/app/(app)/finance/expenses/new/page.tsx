import type { Metadata } from 'next'

import Link from 'next/link'

import {
  CreateExpenseForm,
  type ExpenseProperty,
} from '@/components/finance/create-expense-form'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import { shellContext } from '../../../_lib/context'
import { requireGrant } from '../../../_lib/guard'

export const metadata: Metadata = { title: 'הוצאה חדשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Writing down a cost.
 *
 * GATING. `requireGrant('expense.create')` refuses the route outright, and
 * `createExpenseRuleAction` refuses again with `assertCan` before it reads
 * anything — so reaching this URL without the grant lands on the dashboard with
 * the missing grant named, and posting the action directly is refused
 * regardless. The operation behind it asserts the same permission a third time
 * against the scope its own input describes, because a create operation has no
 * loaded resource for the pipeline to check scope against.
 *
 * WHAT THE FORM IS GIVEN. The properties this membership actually reaches,
 * from the shell's own resolution — so a manager scoped to one property cannot
 * pick another from a list, and the server refuses it anyway if they do.
 *
 * WHAT IT IS NOT GIVEN IS A LEDGER ROW. This writes an `expense_rules` row: the
 * terms of a recurring cost, which `finance_snapshots` later freezes onto a
 * booking. There is no `expenses` table and this form does not create the
 * illusion of one — which is why it asks for a frequency or a formula rather
 * than for a date and an amount.
 */
export default async function NewExpensePage() {
  const [, context] = await Promise.all([
    requireGrant('expense.create'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  // A property with no readable name is dropped rather than offered as a blank
  // option: picking "" from a list is not a choice anybody can make on purpose.
  const properties: ExpenseProperty[] = context.properties
    .filter(
      (property): property is { id: string; name: string } =>
        typeof property.name === 'string' && property.name.length > 0,
    )
    .map((property) => ({ id: property.id, name: property.name }))

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/finance/expenses"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת ההוצאות
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          הוצאה חדשה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          מה שנשמר כאן הוא כלל, לא שורה בחודש: תדירות או נוסחה, ושיטת הייחוס
          שקובעת אילו הזמנות נושאות אותו. עריכה של כלל בעתיד לא תשנה כמה עלתה
          הזמנה שכבר הסתיימה — התנאים מוקפאים על ההזמנה בזמן אמת.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">תנאי ההוצאה</CardTitle>
          <CardDescription>
            שיטת הייחוס אינה פרט טכני. פריסה לפי ימי התקופה אומרת שהעלות קיימת
            גם בלי אורחים; פריסה לפי לילות תפוסים אומרת את ההפך. שתיהן
            לגיטימיות, והבחירה היא של העסק.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          <CreateExpenseForm properties={properties} />
        </div>
      </Card>
    </div>
  )
}
