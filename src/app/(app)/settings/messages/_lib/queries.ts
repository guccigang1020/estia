/**
 * EXECUTION CONTEXT — SERVER ONLY. The wording a business has written.
 *
 * Inactive templates are loaded WITH the rest and marked, never filtered out
 * here. A business that switched its own wording off must be able to see it,
 * switch it back on, and understand why its guests are receiving the built-in
 * Hebrew in the meantime. Hiding the row would make the screen say "you have
 * written nothing" to somebody who wrote something.
 */

import { type Db } from '@/lib/persistence'
import {
  MessageTemplateRepository,
  type MessageTemplate,
} from '@/lib/messaging/template-repository'

export type MessagesScreen =
  | { readonly status: 'not_provisioned' }
  | { readonly status: 'ready'; readonly templates: readonly MessageTemplate[] }

function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

export async function loadMessagesScreen(
  db: Db,
  organizationId: string,
): Promise<MessagesScreen> {
  try {
    const repository = new MessageTemplateRepository(db)
    return {
      status: 'ready',
      templates: await repository.all(organizationId),
    }
  } catch (error) {
    if (isMissingSchema(error)) return { status: 'not_provisioned' }
    throw error
  }
}
