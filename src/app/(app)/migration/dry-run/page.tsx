import type { Metadata } from 'next'

import { DryRunStep } from '@/components/migration/steps/dry-run-step'

export const metadata: Metadata = { title: 'ייבוא — הרצה יבשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Step five, and the one that matters.
 *
 * The dry run has a URL of its own because it is the document an operator
 * forwards: to a partner, to an accountant, to whoever actually holds
 * `migration.apply`. A modal step could not be sent to anybody.
 */
export default function MigrationDryRunPage() {
  return <DryRunStep />
}
