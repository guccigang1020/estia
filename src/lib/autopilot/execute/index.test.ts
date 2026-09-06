/**
 * The barrel.
 *
 * A module whose public surface is exported from one file has one place to look
 * for what it offers — and one place where removing something is a visible
 * edit. This test is the thing that fails when a rename quietly drops a name
 * the rest of the application imports.
 */

import { describe, expect, it } from 'vitest'

import * as execute from './index'

describe('the execution layer surface', () => {
  it('offers the four things a caller does with an action', () => {
    expect(typeof execute.dispatchAction).toBe('function')
    expect(typeof execute.approveAction).toBe('function')
    expect(typeof execute.retryAction).toBe('function')
    expect(typeof execute.undoAction).toBe('function')
  })

  it('offers the parts that have to be injected', () => {
    expect(typeof execute.createCommandRegistry).toBe('function')
    expect(typeof execute.operationHandler).toBe('function')
    expect(typeof execute.idempotencyLedger).toBe('function')
    expect(typeof execute.InMemoryAutopilotLedger).toBe('function')
    expect(typeof execute.SupabaseAutopilotActionRepository).toBe('function')
    expect(typeof execute.InMemoryAutopilotActionRepository).toBe('function')
  })

  it('offers the decisions a screen has to read before it renders a button', () => {
    expect(typeof execute.planUndo).toBe('function')
    expect(typeof execute.decideRetry).toBe('function')
    expect(typeof execute.awaitsApproval).toBe('function')
    expect(typeof execute.simulateAction).toBe('function')
  })

  it('publishes the command bindings, including what is missing', () => {
    expect(execute.boundCommands().length).toBeGreaterThan(0)
    expect(execute.unavailableCommands().length).toBeGreaterThan(0)
    expect(
      execute.boundCommands().length + execute.unavailableCommands().length,
    ).toBe(execute.catalogueCommands().length)
  })
})
