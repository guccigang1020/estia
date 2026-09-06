/**
 * What the handler map claims, asserted against the catalogue itself.
 *
 * The one property worth proving here is negative: a command with no port is
 * ABSENT rather than present and lying. A stub that resolved would put
 * `executed` in the activity log beside a guest who was never messaged, and the
 * log would repeat that forever — so the test that matters is the one that
 * fails if somebody adds a placeholder to make the number go up.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '../../persistence/fake-client'
import { InMemoryAuditWriter } from '../../audit/pipeline'
import type { OperationServices } from '../../service'
import {
  COMMAND_BINDINGS,
  boundCommands,
  createCommandRegistry,
} from '../execute'

import { UNWIRED_COMMANDS, autopilotCommandHandlers } from './handlers'

const ORG = '11111111-1111-4111-8111-111111111111'

function services(): OperationServices {
  return { audit: new InMemoryAuditWriter() }
}

function handlers() {
  return autopilotCommandHandlers({
    db: new FakeSupabaseClient().asDb(),
    services: services(),
    organizationId: ORG,
    context: () => {
      throw new Error('not invoked by construction')
    },
  })
}

describe('the handler map', () => {
  it('binds only commands the catalogue has an operation for', () => {
    const bound = new Set(boundCommands())

    for (const command of Object.keys(handlers())) {
      expect(COMMAND_BINDINGS[command]?.operation).not.toBeNull()
      // `tasks.cancelTask` is bound and is deliberately not an action kind —
      // it is the reversal `undo.ts` names — so the catalogue check is on the
      // binding rather than on `boundCommands()`.
      expect(bound.has(command) || command === 'tasks.cancelTask').toBe(true)
    }
  })

  it('resolves every command it carries to a real operation', () => {
    const registry = createCommandRegistry(handlers())

    for (const command of Object.keys(handlers())) {
      const resolution = registry.resolve(command)
      expect(resolution.status).toBe('available')
      if (resolution.status !== 'available') return
      expect(resolution.operation).toBe(COMMAND_BINDINGS[command]?.operation)
    }
  })

  it('leaves a command whose port is missing OUT rather than stubbing it', () => {
    const map = handlers()
    const registry = createCommandRegistry(map)

    for (const command of Object.keys(UNWIRED_COMMANDS)) {
      expect(map[command]).toBeUndefined()

      const resolution = registry.resolve(command)
      expect(resolution.status).toBe('unavailable')
      // The refusal names the command, so the activity screen can say which
      // one is missing rather than "something went wrong".
      if (resolution.status === 'unavailable') {
        expect(resolution.detail).toContain(command)
      }
    }
  })

  it('states a reason for every command it does not carry', () => {
    const carried = new Set(Object.keys(handlers()))

    for (const command of boundCommands()) {
      if (carried.has(command)) continue
      // No silent gaps: a bound command this map does not hold has its reason
      // written down where a reviewer reads it.
      expect(UNWIRED_COMMANDS[command]).toBeTypeOf('string')
    }
  })

  it('carries the messaging commands only when the operations are supplied', () => {
    expect(handlers()['messaging.sendGuestMessage']).toBeUndefined()
    expect(handlers()['notifications.notifyTeam']).toBeUndefined()
  })
})
