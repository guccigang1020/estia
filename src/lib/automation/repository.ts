/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading `automation_rules` out of Postgres.
 *
 * `state.ts` says where this belongs — "PURE. Rows in, rules out. The reads
 * live in `repository.ts`" — and this is that file. It decides nothing.
 *
 * ── The mapping is where the interesting mistakes are ─────────────────────
 *
 * One of them is worth naming. `parameters` is a jsonb column, so PostgREST
 * hands it back as whatever JSON it holds, and this file will not pass a
 * non-numeric value through: `0067` refuses to store one and `conditions.ts`
 * would evaluate one as `not_comparable` forever, so a value that somehow
 * arrived as a string is dropped here with the rest of the set intact. The
 * effect is that the rule falls back to its shipped number rather than
 * silently never matching — the failure mode this whole module is built to
 * avoid.
 *
 * The client is passed in, as everywhere else in this codebase. Nothing here
 * constructs one and nothing here reaches for a service-role key: the reads
 * and the writes both run as the signed-in person, under the policies 0067
 * declares.
 */

import {
  asNumber,
  asString,
  asStringOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import type { StoredRule } from './state'

const TABLE = 'automation_rules'

const COLUMNS =
  'id, template_id, property_id, enabled, parameters, ' +
  'enabled_at, enabled_by, disabled_at, updated_at, version'

/**
 * The stored numbers, with anything that is not one left out.
 *
 * Not an exception: a single bad key must not make a whole organization's
 * automation screen fail to render. It is dropped, the rule keeps its shipped
 * value for that parameter, and the difference is visible on the screen as a
 * threshold that did not change.
 */
function toParameters(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const parameters: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      parameters[key] = entry
    }
  }
  return parameters
}

function toStoredRule(row: Row): StoredRule {
  return {
    id: asString(row, 'id'),
    templateId: asString(row, 'template_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    enabled: row.enabled === true,
    parameters: toParameters(row.parameters),
    enabledAt: asStringOrNull(row, 'enabled_at'),
    enabledBy: asStringOrNull(row, 'enabled_by'),
    disabledAt: asStringOrNull(row, 'disabled_at'),
    updatedAt: asString(row, 'updated_at'),
    version: asNumber(row, 'version'),
  }
}

export class AutomationRuleRepository {
  constructor(private readonly db: Db) {}

  /**
   * Every stored decision in the organization — the organization-wide rows and
   * the per-property ones together.
   *
   * Deliberately not filtered by property. `resolveRules` needs the property
   * rows even when the reader is looking at the organization view, because
   * "this is set differently at three of your properties" is a sentence the
   * screen has to be able to say. The table holds at most one row per rule per
   * property and the library has fourteen rules, so this is small by
   * construction rather than by a limit somebody has to remember.
   */
  async stored(organizationId: string): Promise<readonly StoredRule[]> {
    const { data, error } = await this.db
      .from(TABLE)
      .select(COLUMNS)
      .eq('organization_id', organizationId)

    if (error) throw error
    return toRows(data).map(toStoredRule)
  }

  /**
   * One rule's row for one scope, or null.
   *
   * The null property is matched with `is`, not `eq`: `eq('property_id', null)`
   * asks PostgREST for `property_id=eq.null`, which matches nothing, and the
   * write path would then insert a second organization-wide row and hit the
   * partial unique index. The two calls look almost identical and behave
   * completely differently, which is why this is one function rather than two
   * call sites.
   */
  async rule(
    organizationId: string,
    templateId: string,
    propertyId: string | null,
  ): Promise<StoredRule | null> {
    const query = this.db
      .from(TABLE)
      .select(COLUMNS)
      .eq('organization_id', organizationId)
      .eq('template_id', templateId)

    const scoped =
      propertyId === null
        ? query.is('property_id', null)
        : query.eq('property_id', propertyId)

    const { data, error } = await scoped.maybeSingle()

    if (error) throw error
    return data ? toStoredRule(toRow(data)) : null
  }
}
