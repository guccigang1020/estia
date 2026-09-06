import type { Metadata } from 'next'

import { UploadStep } from '@/components/migration/steps/upload-step'

export const metadata: Metadata = { title: 'ייבוא — הקובץ' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Step one of the migration.
 *
 * A thin route. The gate, the person's grants and the wizard's state all live
 * in `../layout.tsx`, so this page's whole job is to name which step this URL
 * is. The step itself is a Client Component because the file is read by the
 * browser and never uploaded — see `components/migration/wizard-state.tsx`.
 */
export default function MigrationUploadPage() {
  return <UploadStep />
}
