/**
 * One listing, judged.
 *
 * ══ A UNIT IS JUDGED ON ITS PROPERTY'S WORK TOO ═════════════════════════════
 *
 * `reportForUnit` runs the property's checks as well as the unit's, and that
 * is not padding. A guest booking a suite is choosing the place it sits in: if
 * the property has no cancellation policy and no coordinates, this suite is a
 * bad listing no matter how well the suite itself is filled in. Scoring the
 * unit alone would hand somebody a 95 for a listing a guest cannot find on a
 * map and cannot cancel.
 *
 * The consequence is that fixing one property lifts every unit under it at
 * once, which is also the truth about the work.
 */

import { checkProperty, checkUnit } from './checks'
import { scoreOf } from './score'
import type { ListingProperty, ListingReport, ListingUnit } from './types'

export function reportForProperty(property: ListingProperty): ListingReport {
  const checks = checkProperty(property)
  return {
    propertyId: property.id,
    unitId: null,
    name: property.name,
    score: scoreOf(checks),
    checks,
  }
}

export function reportForUnit(
  property: ListingProperty,
  unit: ListingUnit,
): ListingReport {
  // Property first: the ordering is what a reader sees, and the property's
  // failures are the ones that affect every other unit as well.
  const checks = [...checkProperty(property), ...checkUnit(unit)]
  return {
    propertyId: property.id,
    unitId: unit.id,
    name: `${property.name} · ${unit.name}`,
    score: scoreOf(checks),
    checks,
  }
}
