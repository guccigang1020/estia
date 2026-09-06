'use client'

/**
 * Step one: which body of records this is, and the file.
 *
 * ── Client, because the file is read here and only here ───────────────────
 *
 * `file.text()` is a browser API and `parseSource` is a pure function, so the
 * whole of step one happens on this machine. Nothing is uploaded. That is worth
 * a sentence on the screen — a person about to hand over their entire customer
 * list is entitled to know that choosing a file has not yet sent it anywhere.
 *
 * ── The entity is chosen before the file, on purpose ──────────────────────
 *
 * `parseSource` needs it: the same iCal feed is a calendar of bookings or a
 * list of blocked dates depending on what the operator says it is, and the
 * field vocabulary the mapping step offers is narrowed by it. Asking afterwards
 * would mean re-parsing.
 */

import { useRouter } from 'next/navigation'

import { StepHeader } from '@/components/migration/step-header'
import { useMigration } from '@/components/migration/wizard-state'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { STEP_PATH } from '@/app/(app)/migration/_lib/steps'
import { IMPORT_ENTITY_LABEL, type ImportEntity } from '@/lib/migration/types'

/**
 * The bodies a person can choose today.
 *
 * A subset of `IMPORT_ENTITIES` and not all ten, because these are the ones a
 * real export from another PMS contains as its own sheet. The dry run says
 * plainly which of them this build can actually write, so nothing here promises
 * a write that `apply.ts` would refuse.
 */
const CHOOSABLE: readonly ImportEntity[] = [
  'bookings',
  'guests',
  'properties',
  'units',
  'blocked_dates',
]

export function UploadStep() {
  const router = useRouter()
  const { entity, unitName, chooseEntity, chooseUnitName, readFile, parsed } =
    useMigration()

  async function choose(file: File): Promise<void> {
    await readFile(file)
    router.push(STEP_PATH.detect)
  }

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="upload" />

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
        <Field
          label="מה מייבאים"
          description="קובץ אחד, גוף אחד. יומן iCal אחד הוא היומן של יחידה אחת."
        >
          <Select
            value={entity}
            onChange={(event) =>
              chooseEntity(event.target.value as ImportEntity)
            }
          >
            {CHOOSABLE.map((option) => (
              <option key={option} value={option}>
                {IMPORT_ENTITY_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="שם היחידה (ליומן iCal בלבד)"
          description="יומן של ערוץ אינו אומר איזו יחידה הוא מתאר — הכתובת שממנה הורד אמרה זאת, וכאן צריך להגיד לנו."
        >
          <TextInput
            value={unitName}
            onChange={(event) => chooseUnitName(event.target.value)}
            placeholder="וילה הגלבוע"
          />
        </Field>

        <Field
          label="קובץ"
          description="CSV, טבלה מופרדת בטאבים, גיליון שיוצא מאקסל, או יומן iCal."
        >
          <input
            type="file"
            accept=".csv,.tsv,.txt,.ics,.ical,text/csv,text/calendar"
            className="text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void choose(file)
            }}
          />
        </Field>

        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          הקובץ נקרא כאן, בדפדפן שלכם. הוא אינו נשלח לשרת בשלב הזה ולא בשלב
          המיפוי — רק ההרצה היבשה שולחת אותו, ורק אחרי שתבקשו. אפשר לקחת עשרים
          דקות על המיפוי בלי ששום דבר יצא מהמחשב.
        </p>
      </div>

      {parsed !== null && parsed.rows.length === 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-danger bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            הקובץ לא הניב שורות
          </h3>
          <ul className="flex flex-col gap-2">
            {parsed.issues.map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
              >
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
