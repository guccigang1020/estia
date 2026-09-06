'use client'

/**
 * Step three: which column is which.
 *
 * ── The step where a migration is won or silently ruined ──────────────────
 *
 * Everything else in this wizard is arithmetic. Here a person looks at
 * twenty-four columns out of the product they are leaving and says what each
 * one means. Put the departure date in the arrival column and three years of
 * stays land on plausible wrong days — a mistake nobody notices until a guest
 * turns up.
 *
 * The table itself is `FieldMappingTable`, which refuses to guess and refuses
 * to offer a field twice. This screen adds the two things around it: how much
 * of the file is understood so far, and which required fields are still
 * unclaimed — because "you have mapped six of twenty-four columns" is a fact
 * somebody can act on and a bare grid is not.
 */

import { FieldMappingTable } from '@/components/migration/field-mapping'
import { StepBlocked, StepHeader } from '@/components/migration/step-header'
import { StepNav } from '@/components/migration/step-nav'
import { useMigration } from '@/components/migration/wizard-state'
import { blockedReason } from '@/app/(app)/migration/_lib/steps'
import { IMPORT_FIELD_LABEL } from '@/lib/migration/mapping'

export function MapStep() {
  const { parsed, mappings, availableFields, remap, progress } = useMigration()
  const blocked = blockedReason('map', progress)

  if (blocked !== null || parsed === null) {
    return <StepBlocked step="map" reason={blocked ?? 'עדיין לא נבחר קובץ.'} />
  }

  const claimed = new Set(
    mappings
      .filter((mapping) => mapping.field !== null)
      .map((mapping) => mapping.field),
  )
  const unclaimed = availableFields.filter((field) => !claimed.has(field))

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="map">
        <p className="text-sm text-foreground">
          {progress.mappedFields} מתוך {parsed.columns.length} עמודות מופו.
        </p>
      </StepHeader>

      <FieldMappingTable
        columns={parsed.columns}
        mappings={mappings}
        available={availableFields}
        rows={parsed.rows}
        onChange={remap}
      />

      {unclaimed.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            שדות שאף עמודה לא מזינה
          </h3>
          <p className="text-sm text-muted-foreground">
            לא בהכרח בעיה: קובץ שאין בו אימיילים פשוט אין בו אימיילים. שדה חובה
            שנשאר כאן ייצור שגיאה בבדיקת השורות, עם שם השדה ומספר השורה.
          </p>
          <p className="text-sm text-foreground">
            {unclaimed.map((field) => IMPORT_FIELD_LABEL[field]).join(' · ')}
          </p>
        </section>
      )}

      <StepNav
        back="detect"
        forward="validate"
        forwardBlocked={blockedReason('validate', progress)}
      />
    </section>
  )
}
