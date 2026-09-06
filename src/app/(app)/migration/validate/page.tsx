import type { Metadata } from 'next'

import { ValidateStep } from '@/components/migration/steps/validate-step'

export const metadata: Metadata = { title: 'ייבוא — בדיקת השורות' }

/** EXECUTION CONTEXT — SERVER COMPONENT. Step four. See `../layout.tsx`. */
export default function MigrationValidatePage() {
  return <ValidateStep />
}
