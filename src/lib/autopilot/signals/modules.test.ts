import { describe, expect, it } from 'vitest'

import { FORBIDDEN_IN_SIMPLE } from '../../laundry/mode'

import {
  ALL_MODULES,
  MODULE_LABEL,
  NO_MODULES,
  SIGNAL_MODULES,
  canProjectStock,
  canReserveStock,
  isModuleEnabled,
  laundryHasProvider,
  laundryWords,
  type EnabledModules,
} from './modules'

describe('isModuleEnabled', () => {
  it('reports every module off for a business that runs nothing', () => {
    for (const name of SIGNAL_MODULES) {
      expect(isModuleEnabled(NO_MODULES, name)).toBe(false)
    }
  })

  it('reports every module on for a business that runs everything', () => {
    for (const name of SIGNAL_MODULES) {
      expect(isModuleEnabled(ALL_MODULES, name)).toBe(true)
    }
  })

  it('reads the laundry mode rather than a flag', () => {
    const simple: EnabledModules = { ...NO_MODULES, laundry: 'simple' }
    expect(isModuleEnabled(simple, 'laundry')).toBe(true)
    expect(isModuleEnabled({ ...simple, laundry: 'off' }, 'laundry')).toBe(
      false,
    )
  })

  it('reads the inventory capabilities rather than the mode', () => {
    const counting: EnabledModules = {
      ...NO_MODULES,
      inventory: { ...NO_MODULES.inventory, enabled: true, counting: true },
    }
    expect(isModuleEnabled(counting, 'inventory')).toBe(true)
    // Counting is not reserving, and the distinction is the whole point.
    expect(canReserveStock(counting)).toBe(false)
    expect(canProjectStock(counting)).toBe(false)
  })
})

describe('stock language', () => {
  it('permits reservation only where the module can actually reserve', () => {
    expect(canReserveStock(ALL_MODULES)).toBe(true)
    expect(canReserveStock(NO_MODULES)).toBe(false)
  })
})

describe('laundry vocabulary', () => {
  it('gives a simple operation words that imply no operation', () => {
    const simple: EnabledModules = { ...NO_MODULES, laundry: 'simple' }
    const words = laundryWords(simple)
    const text = Object.values(words).join(' ')
    for (const forbidden of FORBIDDEN_IN_SIMPLE) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('knows there is nobody to chase without an outside provider', () => {
    expect(laundryHasProvider({ ...NO_MODULES, laundry: 'simple' })).toBe(false)
    expect(laundryHasProvider({ ...NO_MODULES, laundry: 'internal' })).toBe(
      false,
    )
    expect(laundryHasProvider({ ...NO_MODULES, laundry: 'external' })).toBe(
      true,
    )
    expect(laundryHasProvider({ ...NO_MODULES, laundry: 'hybrid' })).toBe(true)
  })
})

describe('the vocabulary itself', () => {
  it('labels every module, so no screen invents a name', () => {
    for (const name of SIGNAL_MODULES) {
      expect(MODULE_LABEL[name].length).toBeGreaterThan(0)
    }
  })
})
