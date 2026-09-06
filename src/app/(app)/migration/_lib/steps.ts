/**
 * The eight steps of a migration, and which of them a person may open.
 *
 * ── Why there is a route per step ─────────────────────────────────────────
 *
 * A three-year migration is not one sitting. The file is uploaded, the mapping
 * argued about, the dry run read out loud to whoever actually owns the
 * business, the conflicts settled over two days. Each of those is a URL, so a
 * person can say "look at /migration/dry-run" to a colleague instead of
 * describing the fourth screen of a modal.
 *
 * The file itself stays in the browser and is deliberately not in the URL — see
 * `components/migration/wizard-state.tsx`. That is the one thing the autopilot
 * wizard could put in query parameters and this one cannot: nobody is emailing
 * a link that carries eighteen hundred rows of somebody else's customers.
 *
 * ── Reachability is stated, never guessed ─────────────────────────────────
 *
 * `reachable` answers with a reason. A step that is not yet available renders
 * as a sentence saying what is missing, because a greyed-out item with no
 * explanation is the thing that makes a person close the tab: they cannot tell
 * whether they did something wrong or the product is broken.
 *
 * Pure. No React, no database, no clock — every function here takes a plain
 * progress summary and returns a string or a boolean, which is what lets the
 * whole flow be tested without rendering anything.
 */

export const MIGRATION_STEPS = [
  'upload',
  'detect',
  'map',
  'validate',
  'dry_run',
  'conflicts',
  'import',
  'report',
] as const

export type MigrationStep = (typeof MIGRATION_STEPS)[number]

/** The route each step lives at. Underscored keys, hyphenated URLs. */
export const STEP_PATH: Readonly<Record<MigrationStep, string>> = {
  upload: '/migration/upload',
  detect: '/migration/detect',
  map: '/migration/map',
  validate: '/migration/validate',
  dry_run: '/migration/dry-run',
  conflicts: '/migration/conflicts',
  import: '/migration/import',
  report: '/migration/report',
}

export const STEP_TITLE: Readonly<Record<MigrationStep, string>> = {
  upload: 'הקובץ',
  detect: 'מה הקובץ הזה',
  map: 'איזו עמודה היא מה',
  validate: 'בדיקת השורות',
  dry_run: 'הרצה יבשה',
  conflicts: 'ההחלטות שלך',
  import: 'הייבוא',
  report: 'דוח הסיום',
}

export const STEP_LEAD: Readonly<Record<MigrationStep, string>> = {
  upload:
    'קובץ אחד, גוף אחד. הקובץ נקרא כאן בדפדפן ואינו נשלח לשום מקום בשלב הזה.',
  detect:
    'מה שהתגלה בתוכן, לא בשם הקובץ. שם קובץ שגוי הוא הדבר הכי שכיח בייצוא ממערכת אחרת.',
  map: 'כאן ייבוא מצליח או נהרס בשקט. עמודה שלא זוהתה נשארת ריקה במכוון.',
  validate:
    'כל שורה נקראת ונבדקת. שגיאה דוחה שורה אחת בלבד; אזהרה מייבאת ואומרת מה הונח.',
  dry_run:
    'מה בדיוק יקרה — לפני שנכתב משהו. המסך הזה קורא בלבד, וזו תכונה של החתימה עצמה.',
  conflicts:
    'שום שורה לא נמחקת בשקט. כל התנגשות מוצגת עם שני הצדדים וממתינה להכרעה שלך.',
  import: 'הכתיבה. רק מכאן משהו משתנה, ורק מה שההרצה היבשה כבר הראתה לך ייכתב.',
  report: 'מה קרה בפועל, שורה אחר שורה, לפי מספרי השורות שבגיליון שלך.',
}

/**
 * What the operator has actually got to, as plain facts.
 *
 * Deliberately not the wizard's state object: this is the small set of
 * questions reachability depends on, so a test can state a situation in five
 * lines instead of constructing a parsed file.
 */
export type MigrationProgress = {
  /** A file was chosen and read. It may still have produced no rows. */
  hasFile: boolean
  /** The parse produced at least one row. */
  rowCount: number
  /** How many source columns are mapped onto an ESTIA field. */
  mappedFields: number
  /** Rows the validation understood well enough to consider writing. */
  validRecords: number
  /** A dry run has been computed against this exact mapping. */
  hasDryRun: boolean
  /** Conflicts still waiting on a person. */
  undecided: number
  /** Rows the dry run says would be written. */
  writable: number
  /** The import ran and produced a report. */
  hasCompletion: boolean
}

export const NO_PROGRESS: MigrationProgress = {
  hasFile: false,
  rowCount: 0,
  mappedFields: 0,
  validRecords: 0,
  hasDryRun: false,
  undecided: 0,
  writable: 0,
  hasCompletion: false,
}

export function stepIndex(step: MigrationStep): number {
  return MIGRATION_STEPS.indexOf(step)
}

export function nextStep(step: MigrationStep): MigrationStep | null {
  return MIGRATION_STEPS[stepIndex(step) + 1] ?? null
}

export function previousStep(step: MigrationStep): MigrationStep | null {
  const index = stepIndex(step)
  return index <= 0 ? null : (MIGRATION_STEPS[index - 1] ?? null)
}

/** The step a path belongs to, or `null` for the landing page. */
export function stepFromPath(pathname: string): MigrationStep | null {
  const trimmed = pathname.replace(/\/+$/, '')
  return MIGRATION_STEPS.find((step) => STEP_PATH[step] === trimmed) ?? null
}

/**
 * Why this step cannot be opened yet, in one Hebrew sentence, or `null`.
 *
 * A sentence rather than a boolean because the boolean is the part a person
 * can already see. What they cannot see is which of eight things is missing,
 * and answering that is the difference between a wizard and a locked door.
 */
export function blockedReason(
  step: MigrationStep,
  progress: MigrationProgress,
): string | null {
  switch (step) {
    case 'upload':
      return null

    case 'detect':
      return progress.hasFile ? null : 'עדיין לא נבחר קובץ.'

    case 'map':
      if (!progress.hasFile) return 'עדיין לא נבחר קובץ.'
      return progress.rowCount > 0
        ? null
        : 'הקובץ לא הניב שורות, ולכן אין עמודות למפות.'

    case 'validate':
      if (progress.rowCount === 0) return 'אין שורות לבדוק.'
      return progress.mappedFields > 0
        ? null
        : 'אף עמודה עדיין לא מופתה לשדה ב-ESTIA.'

    case 'dry_run':
      if (progress.rowCount === 0) return 'אין שורות להריץ.'
      return progress.mappedFields > 0
        ? null
        : 'אף עמודה עדיין לא מופתה לשדה ב-ESTIA.'

    case 'conflicts':
      return progress.hasDryRun
        ? null
        : 'ההתנגשויות מתגלות בהרצה היבשה. הריצו אותה קודם.'

    case 'import':
      if (!progress.hasDryRun)
        return 'אין ייבוא בלי הרצה יבשה שקראתם. הריצו אותה קודם.'
      if (progress.undecided > 0)
        return `${progress.undecided} התנגשויות עדיין ממתינות להכרעה.`
      return progress.writable > 0
        ? null
        : 'ההרצה היבשה לא מצאה שורה אחת לכתיבה.'

    case 'report':
      return progress.hasCompletion ? null : 'עדיין לא רץ ייבוא.'
  }
}

export function isReachable(
  step: MigrationStep,
  progress: MigrationProgress,
): boolean {
  return blockedReason(step, progress) === null
}

/**
 * The step this migration has actually got to.
 *
 * The furthest reachable step, walked forward from the start rather than
 * inferred from the most advanced piece of state. Walking forward means a
 * cleared mapping pulls the marker back to `map`, which is the honest answer:
 * a dry run computed against a mapping that no longer exists describes nothing.
 */
export function furthestStep(progress: MigrationProgress): MigrationStep {
  let furthest: MigrationStep = 'upload'
  for (const step of MIGRATION_STEPS) {
    if (!isReachable(step, progress)) break
    furthest = step
  }
  return furthest
}
