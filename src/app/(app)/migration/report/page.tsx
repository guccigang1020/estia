import type { Metadata } from 'next'

import { ReportStep } from '@/components/migration/steps/report-step'

export const metadata: Metadata = { title: 'ייבוא — דוח הסיום' }

/** EXECUTION CONTEXT — SERVER COMPONENT. Step eight. See `../layout.tsx`. */
export default function MigrationReportPage() {
  return <ReportStep />
}
