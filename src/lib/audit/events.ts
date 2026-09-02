/**
 * Audit events.
 *
 * The record of who did what. Two things make this useful rather than
 * ceremonial:
 *
 *   1. It says what changed, not that something changed. "Daniel changed the
 *      booking total from ₪5,200 to ₪4,700" answers the question a manager
 *      actually has; "booking updated" does not.
 *
 *   2. An actor is not always a person. ESTIA writes marketing copy, picks
 *      photographs and optimises pages on its own, and those actions have to
 *      be attributable in the same timeline as human ones — otherwise the
 *      history reads as though a person made a change nobody remembers making.
 *
 * This is the TypeScript half of a contract shared with the `audit_events`
 * table. The two must agree on every enum value.
 */

/**
 * Who performed the action.
 *
 * `ai_agent` is deliberately its own kind and not a service account with a
 * friendly name. When a customer asks why their homepage headline changed, the
 * answer has to distinguish "an employee decided" from "the system generated,
 * and a named employee approved".
 */
/**
 * Who did the thing.
 *
 * `guest` is the newest and the one that needed an argument. A guest holds no
 * membership, no role and no `auth.uid()` — they hold a capability URL — so a
 * guest confirming their booking, signing a contract or asking for two extra
 * towels produced no audit row at all, and the append-only tables carried the
 * timestamp without the actor.
 *
 * Folding them into `system` was the obvious shortcut and is refused for the
 * reason 0005 gives about AI agents: an action taken by somebody outside the
 * business must never be indistinguishable from one the business took itself.
 * In a dispute about what a guest agreed to, "system" is the wrong answer.
 */
export type ActorType =
  'user' | 'system' | 'ai_agent' | 'platform_staff' | 'guest'

export interface AuditActor {
  type: ActorType
  /**
   * Present for `user` and `platform_staff`; null for autonomous actions, and
   * always null for a `guest` — they have no row in `auth.users` at all. What
   * identifies them is the booking the action was taken against, which the
   * event's own resource already carries.
   */
  userId: string | null
  /**
   * How the actor is named in the timeline: a person's name, a job name
   * (`nightly-availability-sync`), or the agent (`Website Studio · Copywriter`).
   */
  label: string
  /** For AI actions: the person who asked for it, or who approved the result. */
  onBehalfOfUserId?: string | null
}

export interface AuditContext {
  organizationId: string
  propertyId?: string | null
  /** Ties every event produced by one request together. */
  requestId: string
  ip?: string | null
  userAgent?: string | null
}

export interface AuditEventInput {
  actor: AuditActor
  context: AuditContext
  /** The permission that authorised it, so the event and the model stay aligned. */
  action: string
  resourceType: string
  resourceId: string | null
  /** Only the fields that changed, never the whole record. */
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  /** Required for the actions that demand a stated justification. */
  reason?: string | null
  /** The human sentence. Built by the caller, which knows the domain meaning. */
  summary: string
}

/**
 * Reduce a before/after pair to the fields that actually differ.
 *
 * Storing whole records makes the log expensive and makes a real change hard
 * to spot among forty unchanged columns. Comparison is by value for scalars
 * and by JSON shape for anything else — adequate here, and it never reports a
 * false difference for an unchanged field.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
): { before: Partial<T>; after: Partial<T> } {
  const changedBefore: Partial<T> = {}
  const changedAfter: Partial<T> = {}

  if (!before || !after) {
    return { before: before ?? {}, after: after ?? {} }
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const a = before[key as keyof T]
    const b = after[key as keyof T]
    if (!isEqual(a, b)) {
      changedBefore[key as keyof T] = a
      changedAfter[key as keyof T] = b
    }
  }

  return { before: changedBefore, after: changedAfter }
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined)
    return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Fields that must never reach the audit log.
 *
 * The log is widely readable inside an organization and is retained for years,
 * which makes it the worst possible place for a secret. A card token or a
 * password hash recorded here would outlive every rotation.
 */
const NEVER_LOGGED = new Set([
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'card_token',
  'cvv',
  'signature_data',
])

/** Replace sensitive values with a marker, keeping the fact that they changed. */
export function scrubSensitive<T extends Record<string, unknown>>(
  record: T,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    output[key] = NEVER_LOGGED.has(key.toLowerCase()) ? '[redacted]' : value
  }
  return output
}
