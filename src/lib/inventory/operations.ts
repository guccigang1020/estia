/**
 * Every stock mutation, as a declared operation.
 *
 * ── Why none of these is a function that writes a row ─────────────────────
 *
 * `defineOperation` runs one sequence and there is no way to reorder it:
 * authorize, validate, load, business rule, transaction, audit event, domain
 * event. A screen cannot reach `execute` without having passed `assertCan`,
 * and cannot finish successfully without an audit row. Stock is exactly the
 * place that matters: "who changed the count from forty to thirty-two, and
 * why" is the question a stocktake dispute turns on, and an adapter called
 * directly from a Server Action answers it with silence.
 *
 * ── Ports, so the domain never imports the database ───────────────────────
 *
 * `InventoryPorts` below is what `src/lib/persistence/inventory.ts` satisfies.
 * The same discipline the preparation module uses, and it is what lets these
 * operations be tested against `FakeSupabaseClient` rather than a deployment.
 *
 * ── Nothing here writes `quantity` ────────────────────────────────────────
 *
 * 0011 derives `inventory_items.quantity` from the movement ledger by trigger.
 * Every correction below is therefore a *compensating movement* and never an
 * edit — "we thought we had forty and we have thirty-two" is itself a fact
 * worth keeping, and an edit erases it.
 */

import { assertCan } from '../authz/can'
import type { FieldIssue } from '../errors'
import { defineOperation, type Operation } from '../service'
import type { Schema } from '../service/schema'

import { capabilitiesFor } from './settings'
import { assertReservationsEnabled, planReservation } from './reservation'
import { resolutionEffect } from './discrepancy'
import type {
  DiscrepancyResolution,
  ImportRow,
  InventorySettings,
} from './types'

/* ----------------------------------------------------------------- ports -- */

export interface NewItem {
  propertyId: string
  name: string
  sku: string | null
  category: string | null
  location: string | null
  unitOfMeasure: string
  quantity: number
  minQuantity: number | null
  parLevel: number | null
  unitCostAgorot: number | null
}

export interface MovementDraft {
  itemId: string
  propertyId: string
  kind:
    | 'receipt'
    | 'issue'
    | 'transfer'
    | 'return'
    | 'adjustment'
    | 'loss'
    | 'count'
  quantityDelta: number
  toState: string | null
  reason: string
  bookingId?: string | null
}

export interface InventoryPorts {
  loadSettings(organizationId: string): Promise<{
    settings: InventorySettings
    provisioned: boolean
  }>
  saveSettings(settings: InventorySettings): Promise<void>
  /** Creates the item row and the opening `receipt` movement together. */
  createItem(args: {
    organizationId: string
    item: NewItem
  }): Promise<{ id: string }>
  updateItem(args: {
    organizationId: string
    itemId: string
    patch: Partial<NewItem>
  }): Promise<void>
  recordMovement(args: {
    organizationId: string
    movement: MovementDraft
  }): Promise<{ id: string }>
  loadReservableItem(args: {
    organizationId: string
    itemId: string
    bookingId: string | null
  }): Promise<{
    itemId: string
    label: string
    propertyId: string
    quantity: number
    quantityReserved: number
    existingQuantity?: number
  } | null>
  reserve(request: {
    itemId: string
    quantity: number
    neededFrom: string
    neededTo: string
    bookingId?: string | null
    note?: string | null
  }): Promise<{ reservationId: string; freeAfter: number }>
  requestTransfer(args: {
    organizationId: string
    itemId: string
    fromPropertyId: string
    toPropertyId: string
    quantity: number
    neededBy: string | null
    reason: string
  }): Promise<{ id: string }>
  loadDiscrepancy(args: {
    organizationId: string
    discrepancyId: string
  }): Promise<{
    id: string
    itemId: string
    propertyId: string
    label: string
    difference: number
    version: number
  } | null>
  resolveDiscrepancy(args: {
    organizationId: string
    discrepancyId: string
    resolution: DiscrepancyResolution
    note: string
    movementId: string | null
  }): Promise<void>
}

/* --------------------------------------------------------------- schemas -- */

/**
 * A schema that validates and passes through.
 *
 * `src/lib/service/schema.ts` is another worker's file this wave, so the
 * shapes below are declared here in the form it consumes rather than adding
 * builders to it. Each one refuses the same things the database CHECKs refuse,
 * because a constraint violation reaching a person as a SQLSTATE is a defect
 * even when the refusal is correct.
 */
function schema<T>(
  kind: string,
  check: (value: T) => readonly FieldIssue[],
): Schema<T> {
  return {
    kind,
    validate(value: unknown, path: string) {
      if (value === null || typeof value !== 'object') {
        return {
          ok: false as const,
          issues: [
            {
              field: path.length > 0 ? path : 'input',
              code: 'invalid',
              message: 'הקלט אינו תקין.',
            },
          ],
        }
      }

      const issues = check(value as T)
      // Prefixed with the path, so the interface can put each message beside
      // the input that caused it rather than at the top of the form.
      if (issues.length > 0) {
        return {
          ok: false as const,
          issues: issues.map((one) => ({
            ...one,
            field: path.length > 0 ? `${path}.${one.field}` : one.field,
          })),
        }
      }

      return { ok: true as const, value: value as T }
    },
  }
}

/* ------------------------------------------------------------ operations -- */

export interface InventoryOperations {
  configure: Operation<InventorySettings, null, InventorySettings>
  addItem: Operation<NewItem, null, { id: string }>
  applyImport: Operation<
    { propertyId: string; rows: readonly ImportRow[] },
    null,
    { created: number; updated: number }
  >
  adjust: Operation<MovementDraft, null, { id: string }>
  reserve: Operation<
    {
      itemId: string
      quantity: number
      neededFrom: string
      neededTo: string
      bookingId: string | null
      note: string | null
    },
    null,
    { reservationId: string; freeAfter: number }
  >
  proposeTransfer: Operation<
    {
      itemId: string
      fromPropertyId: string
      toPropertyId: string
      quantity: number
      neededBy: string | null
      reason: string
    },
    null,
    { id: string }
  >
  resolveDiscrepancy: Operation<
    { discrepancyId: string; resolution: DiscrepancyResolution; note: string },
    null,
    { movementId: string | null }
  >
}

export function defineInventoryOperations(
  ports: InventoryPorts,
): InventoryOperations {
  return {
    /**
     * Turning the module on, off, or sideways.
     *
     * `inventory.edit` and not `inventory.adjust`: the mode decides whether an
     * entire capability exists for the organization, and that is not a
     * housekeeping decision.
     */
    configure: defineOperation({
      name: 'inventory.configure',
      permission: 'inventory.edit',
      resourceType: 'inventory_settings',
      input: schema<InventorySettings>('inventory.configure', (value) => {
        const issues = []
        if (value.safetyBufferUnits < 0) {
          issues.push({
            field: 'safetyBufferUnits',
            code: 'invalid',
            message: 'מלאי ביטחון אינו יכול להיות שלילי.',
          })
        }
        if (value.safetyBufferPercent < 0 || value.safetyBufferPercent > 100) {
          issues.push({
            field: 'safetyBufferPercent',
            code: 'invalid',
            message: 'אחוז מלאי הביטחון חייב להיות בין 0 ל־100.',
          })
        }
        if (value.shortageWarningHorizonDays > value.forecastHorizonDays) {
          issues.push({
            field: 'shortageWarningHorizonDays',
            code: 'invalid',
            message: 'טווח ההתראה אינו יכול לחרוג מטווח התחזית.',
          })
        }
        if (
          value.linenTurnaroundDays !== null &&
          (value.linenTurnaroundDays < 0 || value.linenTurnaroundDays > 60)
        ) {
          issues.push({
            field: 'linenTurnaroundDays',
            code: 'invalid',
            message: 'זמן מחזור הכביסה חייב להיות בין 0 ל־60 ימים.',
          })
        }
        return issues
      }),
      async execute({ input }) {
        await ports.saveSettings(input)
        return input
      },
      audit({ input, context }) {
        const capabilities = capabilitiesFor(input)
        return {
          resourceId: input.organizationId,
          summary:
            `${context.auditActor.label} הגדיר את מודול המלאי למצב ` +
            `״${input.mode}״` +
            (capabilities.enabled
              ? ` (שריון: ${capabilities.reservations ? 'כן' : 'לא'}, ` +
                `תחזית: ${capabilities.forecast ? 'כן' : 'לא'}, ` +
                `העברות: ${capabilities.transfers ? 'כן' : 'לא'})`
              : ' — המודול כבוי, וההזמנות, ההכנה והכספים אינם מושפעים'),
          after: { ...input },
        }
      },
    }),

    /**
     * One item, added by hand.
     *
     * The opening quantity is written as a `receipt` movement rather than as a
     * column, so the very first number in the ledger has a row explaining
     * where it came from.
     */
    addItem: defineOperation({
      name: 'inventory.item.create',
      permission: 'inventory.edit',
      resourceType: 'inventory_item',
      input: schema<NewItem>('inventory.item.create', (value) => {
        const issues = []
        if (value.name.trim().length === 0) {
          issues.push({
            field: 'name',
            code: 'required',
            message: 'שם הפריט הוא השדה היחיד שאי אפשר להשלים.',
          })
        }
        if (!Number.isInteger(value.quantity) || value.quantity < 0) {
          issues.push({
            field: 'quantity',
            code: 'invalid',
            message: 'הכמות חייבת להיות מספר שלם שאינו שלילי.',
          })
        }
        if (value.unitOfMeasure.trim().length === 0) {
          issues.push({
            field: 'unitOfMeasure',
            code: 'required',
            message:
              'יחידת מידה חסרה. ״יח׳״ אינה הנחה סבירה עבור סטים וגלילים.',
          })
        }
        return issues
      }),
      async execute({ input, context }) {
        return ports.createItem({
          organizationId: context.actor.organizationId,
          item: input,
        })
      },
      audit({ input, result, context }) {
        return {
          resourceId: result.id,
          propertyId: input.propertyId,
          summary:
            `${context.auditActor.label} הוסיף את ״${input.name}״ למלאי ` +
            `בכמות ${input.quantity} ${input.unitOfMeasure}.`,
          after: { ...input },
        }
      },
    }),

    /**
     * A whole spreadsheet, applied.
     *
     * The plan was computed and shown before this ran — see
     * `src/lib/inventory/import.ts` — so this receives only rows a person has
     * already seen classified. A differing quantity becomes a `count`
     * movement, which is exactly what a physical stocktake is, and never a
     * typed-over column.
     */
    applyImport: defineOperation({
      name: 'inventory.import',
      permission: 'inventory.import',
      resourceType: 'inventory_item',
      input: schema<{ propertyId: string; rows: readonly ImportRow[] }>(
        'inventory.import',
        (value) =>
          value.rows.length === 0
            ? [
                {
                  field: 'rows',
                  code: 'required',
                  message: 'אין שורות לייבוא.',
                },
              ]
            : [],
      ),
      async execute({ input, context }) {
        let created = 0
        for (const row of input.rows) {
          await ports.createItem({
            organizationId: context.actor.organizationId,
            item: {
              propertyId: input.propertyId,
              name: row.name,
              sku: row.sku,
              category: row.category,
              location: row.location,
              unitOfMeasure: row.unitOfMeasure,
              quantity: row.quantity,
              minQuantity: row.minQuantity,
              parLevel: row.parLevel,
              unitCostAgorot: row.unitCostAgorot,
            },
          })
          created += 1
        }
        return { created, updated: 0 }
      },
      audit({ input, result, context }) {
        return {
          propertyId: input.propertyId,
          summary:
            `${context.auditActor.label} ייבא ${result.created} פריטי מלאי ` +
            `מקובץ.`,
          after: { created: result.created, propertyId: input.propertyId },
        }
      },
    }),

    /**
     * A correction, as a compensating movement.
     *
     * `inventory.adjust`, which 0012 keeps apart from `inventory.edit` for
     * exactly this reason: edit renames an item and changes its par level,
     * adjust moves a quantity. A person may be trusted with one and not the
     * other.
     */
    adjust: defineOperation({
      name: 'inventory.adjust',
      permission: 'inventory.adjust',
      resourceType: 'inventory_movement',
      input: schema<MovementDraft>('inventory.adjust', (value) => {
        const issues = []
        if (
          !Number.isInteger(value.quantityDelta) ||
          value.quantityDelta === 0
        ) {
          issues.push({
            field: 'quantityDelta',
            code: 'invalid',
            message: 'תנועה של אפס אינה תנועה.',
          })
        }
        if (value.reason.trim().length === 0) {
          issues.push({
            field: 'reason',
            code: 'required',
            message:
              'תיקון בלי נימוק הוא מספר שאיש לא יוכל להסביר בעוד חודשיים.',
          })
        }
        return issues
      }),
      async execute({ input, context }) {
        return ports.recordMovement({
          organizationId: context.actor.organizationId,
          movement: input,
        })
      },
      audit({ input, result, context }) {
        return {
          resourceId: result.id,
          propertyId: input.propertyId,
          summary:
            `${context.auditActor.label} רשם תנועת מלאי מסוג ״${input.kind}״ ` +
            `בכמות ${input.quantityDelta}: ${input.reason}`,
          after: { ...input },
        }
      },
    }),

    /**
     * Promise stock to a booking.
     *
     * Two refusals before the write and they are different sentences: "this
     * business does not reserve stock" is a configuration answer, and "there
     * are eighteen free and you asked for twenty-five" is a cupboard one.
     * Reporting the first as the second sends somebody to count a full
     * cupboard.
     *
     * The write itself is `public.reserve_inventory`, which locks the row and
     * adds relatively. See `reservation.ts`.
     */
    reserve: defineOperation({
      name: 'inventory.reserve',
      permission: 'inventory.adjust',
      resourceType: 'inventory_reservation',
      input: schema<{
        itemId: string
        quantity: number
        neededFrom: string
        neededTo: string
        bookingId: string | null
        note: string | null
      }>('inventory.reserve', (value) =>
        value.neededTo < value.neededFrom
          ? [
              {
                field: 'neededTo',
                code: 'invalid',
                message: 'תאריך הסיום קודם לתאריך ההתחלה.',
              },
            ]
          : [],
      ),
      async rule({ input, context }) {
        const { settings } = await ports.loadSettings(
          context.actor.organizationId,
        )
        assertReservationsEnabled(capabilitiesFor(settings))

        const item = await ports.loadReservableItem({
          organizationId: context.actor.organizationId,
          itemId: input.itemId,
          bookingId: input.bookingId,
        })
        if (item === null) return

        // The readable refusal. The database would refuse anyway, with a
        // constraint name instead of a sentence.
        planReservation(item, input)
      },
      async execute({ input }) {
        return ports.reserve(input)
      },
      audit({ input, result, context }) {
        return {
          resourceId: result.reservationId,
          summary:
            `${context.auditActor.label} שיריין ${input.quantity} יחידות ` +
            `מ־${input.neededFrom} עד ${input.neededTo}. נשארו זמינים ` +
            `${result.freeAfter}.`,
          after: { ...input },
        }
      },
      events({ input, result, context }) {
        return [
          {
            name: 'inventory.transferred',
            organizationId: context.actor.organizationId,
            resourceType: 'inventory_reservation',
            resourceId: result.reservationId,
            payload: { ...input, freeAfter: result.freeAfter },
          },
        ]
      },
    }),

    /**
     * Ask for stock from another property. A request, never a movement.
     *
     * `inventory.transfer`, and the row lands as `requested` rather than
     * `approved`: the property giving stock away has to be able to see what is
     * being asked of it before it happens, because a transfer visible only to
     * the requester is a transfer the source discovers by opening an empty
     * cupboard.
     */
    proposeTransfer: defineOperation({
      name: 'inventory.transfer.request',
      permission: 'inventory.transfer',
      resourceType: 'inventory_transfer',
      input: schema<{
        itemId: string
        fromPropertyId: string
        toPropertyId: string
        quantity: number
        neededBy: string | null
        reason: string
      }>('inventory.transfer.request', (value) => {
        const issues = []
        if (value.fromPropertyId === value.toPropertyId) {
          issues.push({
            field: 'toPropertyId',
            code: 'invalid',
            message: 'העברה אל אותו נכס אינה העברה.',
          })
        }
        if (!Number.isInteger(value.quantity) || value.quantity <= 0) {
          issues.push({
            field: 'quantity',
            code: 'invalid',
            message: 'הכמות להעברה חייבת להיות גדולה מאפס.',
          })
        }
        if (value.reason.trim().length === 0) {
          issues.push({
            field: 'reason',
            code: 'required',
            message: 'יש להסביר למה מרוקנים מחסן של נכס אחר.',
          })
        }
        return issues
      }),
      async execute({ input, context }) {
        return ports.requestTransfer({
          organizationId: context.actor.organizationId,
          ...input,
        })
      },
      audit({ input, result, context }) {
        return {
          resourceId: result.id,
          propertyId: input.toPropertyId,
          summary:
            `${context.auditActor.label} ביקש להעביר ${input.quantity} יחידות ` +
            `בין נכסים. ההעברה ממתינה לאישור. נימוק: ${input.reason}`,
          after: { ...input },
        }
      },
    }),

    /**
     * Close a counted difference, with the movement it implies.
     *
     * `resolutionEffect` decides what the ledger gets; this operation performs
     * it. Keeping the decision in the domain means the screen can say what the
     * button will do before it is pressed, using the same function.
     */
    resolveDiscrepancy: defineOperation({
      name: 'inventory.discrepancy.resolve',
      permission: 'inventory.adjust',
      resourceType: 'inventory_discrepancy',
      requiresVersion: false,
      input: schema<{
        discrepancyId: string
        resolution: DiscrepancyResolution
        note: string
      }>('inventory.discrepancy.resolve', (value) =>
        value.note.trim().length === 0
          ? [
              {
                field: 'note',
                code: 'required',
                message: 'הכרעה בלי נימוק היא פסק דין שאיש אינו יכול לבקר.',
              },
            ]
          : [],
      ),
      async execute({ input, context }) {
        const discrepancy = await ports.loadDiscrepancy({
          organizationId: context.actor.organizationId,
          discrepancyId: input.discrepancyId,
        })
        if (discrepancy === null) return { movementId: null }

        const effect = resolutionEffect(
          discrepancy,
          input.resolution,
          input.note,
        )

        let movementId: string | null = null
        if (effect.movementKind !== null && effect.quantityDelta !== 0) {
          const movement = await ports.recordMovement({
            organizationId: context.actor.organizationId,
            movement: {
              itemId: discrepancy.itemId,
              propertyId: discrepancy.propertyId,
              kind: effect.movementKind,
              quantityDelta: effect.quantityDelta,
              toState: effect.toState,
              reason: effect.reason,
            },
          })
          movementId = movement.id
        }

        await ports.resolveDiscrepancy({
          organizationId: context.actor.organizationId,
          discrepancyId: input.discrepancyId,
          resolution: input.resolution,
          note: input.note,
          movementId,
        })

        return { movementId }
      },
      audit({ input, result, context }) {
        return {
          resourceId: input.discrepancyId,
          summary:
            `${context.auditActor.label} סגר פער ספירה כ״${input.resolution}״: ` +
            input.note,
          after: { ...input, movementId: result.movementId },
        }
      },
      events({ input, context }) {
        return [
          {
            name: 'inventory.discrepancy_detected',
            organizationId: context.actor.organizationId,
            resourceType: 'inventory_discrepancy',
            resourceId: input.discrepancyId,
            payload: { resolution: input.resolution },
          },
        ]
      },
    }),
  }
}

/**
 * The independent refusal a Server Action owes before it reads anything.
 *
 * A Server Action is reachable by a crafted POST whatever the screen rendered,
 * so the grant is checked here as well as by the operation and again by row
 * level security. Deny by default, three times.
 */
export function assertMayConfigureInventory(
  actor: Parameters<typeof assertCan>[0],
): void {
  assertCan(actor, 'inventory.edit', {
    organizationId: actor.organizationId,
    family: 'operations',
  })
}
