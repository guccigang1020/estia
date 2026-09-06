import { describe, expect, it } from 'vitest'

import {
  MIGRATION_STEPS,
  NO_PROGRESS,
  STEP_LEAD,
  STEP_PATH,
  STEP_TITLE,
  blockedReason,
  furthestStep,
  isReachable,
  nextStep,
  previousStep,
  stepFromPath,
  stepIndex,
  type MigrationProgress,
} from './steps'

function progress(patch: Partial<MigrationProgress> = {}): MigrationProgress {
  return { ...NO_PROGRESS, ...patch }
}

/** Everything a file needs before the dry run is a legitimate thing to open. */
const READY_TO_RUN = progress({
  hasFile: true,
  rowCount: 40,
  mappedFields: 6,
  validRecords: 38,
})

describe('the vocabulary', () => {
  it('gives every step a path, a title and a lead', () => {
    for (const step of MIGRATION_STEPS) {
      expect(STEP_PATH[step]).toMatch(/^\/migration\//)
      expect(STEP_TITLE[step].length).toBeGreaterThan(0)
      expect(STEP_LEAD[step].length).toBeGreaterThan(0)
    }
  })

  it('gives every step a distinct path', () => {
    const paths = MIGRATION_STEPS.map((step) => STEP_PATH[step])
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('puts the dry run before the import, never after', () => {
    expect(stepIndex('dry_run')).toBeLessThan(stepIndex('import'))
    expect(stepIndex('conflicts')).toBeLessThan(stepIndex('import'))
  })
})

describe('walking the steps', () => {
  it('runs upload → detect → map → validate → dry run → conflicts → import', () => {
    expect(nextStep('upload')).toBe('detect')
    expect(nextStep('validate')).toBe('dry_run')
    expect(nextStep('dry_run')).toBe('conflicts')
    expect(nextStep('conflicts')).toBe('import')
  })

  it('has no step after the report and none before the upload', () => {
    expect(nextStep('report')).toBeNull()
    expect(previousStep('upload')).toBeNull()
  })

  it('recognises its own paths and nothing else', () => {
    expect(stepFromPath('/migration/dry-run')).toBe('dry_run')
    expect(stepFromPath('/migration/dry-run/')).toBe('dry_run')
    expect(stepFromPath('/migration')).toBeNull()
    expect(stepFromPath('/channels/setup')).toBeNull()
  })
})

describe('reachability', () => {
  it('always allows the upload step, even with nothing at all', () => {
    expect(isReachable('upload', NO_PROGRESS)).toBe(true)
  })

  it('refuses every later step on an empty wizard, each with a reason', () => {
    for (const step of MIGRATION_STEPS) {
      if (step === 'upload') continue
      expect(blockedReason(step, NO_PROGRESS)).not.toBeNull()
    }
  })

  it('lets a file with no rows be inspected but not mapped', () => {
    const parsedNothing = progress({ hasFile: true, rowCount: 0 })
    expect(isReachable('detect', parsedNothing)).toBe(true)
    expect(isReachable('map', parsedNothing)).toBe(false)
    expect(blockedReason('map', parsedNothing)).toContain('שורות')
  })

  it('refuses mapping-dependent steps until a column is mapped', () => {
    const unmapped = progress({ hasFile: true, rowCount: 40 })
    expect(isReachable('map', unmapped)).toBe(true)
    expect(isReachable('validate', unmapped)).toBe(false)
    expect(isReachable('dry_run', unmapped)).toBe(false)
  })

  it('opens the dry run once a mapping exists', () => {
    expect(isReachable('dry_run', READY_TO_RUN)).toBe(true)
  })

  it('will not open the conflict review before a dry run has been computed', () => {
    expect(isReachable('conflicts', READY_TO_RUN)).toBe(false)
    expect(isReachable('conflicts', { ...READY_TO_RUN, hasDryRun: true })).toBe(
      true,
    )
  })
})

describe('the import step is the one that is hard to reach', () => {
  const afterDryRun = { ...READY_TO_RUN, hasDryRun: true, writable: 38 }

  it('refuses an import that no dry run preceded', () => {
    expect(isReachable('import', { ...READY_TO_RUN, writable: 38 })).toBe(false)
  })

  it('refuses while a single conflict is unsettled, and says how many', () => {
    const waiting = { ...afterDryRun, undecided: 3 }
    expect(isReachable('import', waiting)).toBe(false)
    expect(blockedReason('import', waiting)).toContain('3')
  })

  it('refuses when the dry run found nothing to write', () => {
    expect(isReachable('import', { ...afterDryRun, writable: 0 })).toBe(false)
  })

  it('opens once the dry run is read and every conflict is settled', () => {
    expect(isReachable('import', afterDryRun)).toBe(true)
  })
})

describe('the report step', () => {
  it('is closed until an import has actually run', () => {
    const afterDryRun = { ...READY_TO_RUN, hasDryRun: true, writable: 38 }
    expect(isReachable('report', afterDryRun)).toBe(false)
    expect(isReachable('report', { ...afterDryRun, hasCompletion: true })).toBe(
      true,
    )
  })
})

describe('furthestStep', () => {
  it('is the upload step when nothing has happened', () => {
    expect(furthestStep(NO_PROGRESS)).toBe('upload')
  })

  it('stops at the mapping step while nothing is mapped', () => {
    expect(furthestStep(progress({ hasFile: true, rowCount: 40 }))).toBe('map')
  })

  it('stops at the dry run before one has been computed', () => {
    expect(furthestStep(READY_TO_RUN)).toBe('dry_run')
  })

  it('stops at the conflicts while one is unsettled', () => {
    expect(
      furthestStep({
        ...READY_TO_RUN,
        hasDryRun: true,
        writable: 38,
        undecided: 1,
      }),
    ).toBe('conflicts')
  })

  it('walks back when the mapping is cleared, rather than staying ahead', () => {
    // A dry run computed against a mapping that no longer exists describes
    // nothing, so the marker must retreat rather than flatter the operator.
    const stale = progress({
      hasFile: true,
      rowCount: 40,
      mappedFields: 0,
      hasDryRun: true,
      writable: 38,
    })
    expect(furthestStep(stale)).toBe('map')
  })

  it('reaches the report once the import has run', () => {
    expect(
      furthestStep({
        ...READY_TO_RUN,
        hasDryRun: true,
        writable: 38,
        hasCompletion: true,
      }),
    ).toBe('report')
  })
})
