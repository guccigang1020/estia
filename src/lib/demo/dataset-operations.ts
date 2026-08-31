/**
 * The work behind the stays: cleaning and preparation, the checklists that
 * prove they happened, the linen and consumables they consume, and the
 * approvals somebody had to give.
 *
 * ── Tasks follow bookings, because that is where they come from ───────────
 *
 * A cleaning task exists because a guest left; a preparation task exists
 * because one is arriving. Both are generated from the stays rather than
 * written independently, so the operations board and the calendar tell the
 * same story about the same day. A demo where housekeeping is busy on a unit
 * nobody is staying in is a demo of two unrelated screens.
 *
 * ── The window is narrow on purpose ───────────────────────────────────────
 *
 * Only stays inside roughly a fortnight either side of today produce tasks.
 * A business does not carry six months of cleaning jobs in its list, and a
 * task board with two hundred rows on it demonstrates nothing except that
 * somebody generated two hundred rows.
 *
 * ── The cleaner sees this and nothing else ────────────────────────────────
 *
 * Every task carries `team_id`, which is what a `team`-scoped membership
 * matches on. That is the mechanism by which ורד sees her work and does not
 * see a guest's name, a rate or a payment — enforced by the scope, not by a
 * screen deciding to hide a column.
 */

import type { DemoRow } from './types'
import { ID_GROUP, day, idsFor, momentOn, stamped } from './dataset-support'
import { ORGANIZATION_ID, person } from './dataset-identity'
import { PROPERTY_IDS, TEAM_IDS, unit } from './dataset-inventory'
import { BOOKINGS } from './dataset-bookings'

const taskIds = idsFor(ID_GROUP.task)
const assignmentIds = idsFor(ID_GROUP.taskAssignment)
const checklistIds = idsFor(ID_GROUP.taskChecklist)
const itemIds = idsFor(ID_GROUP.inventoryItem)
const movementIds = idsFor(ID_GROUP.inventoryMovement)
const approvalIds = idsFor(ID_GROUP.approval)

const OWNER_ID = person('owner').userId
const MANAGER_ID = person('general-manager').userId
const PROPERTY_MANAGER_ID = person('property-manager').userId
const RECEPTION_ID = person('reception').userId
const CLEANER_ID = person('housekeeping').userId
const SECOND_CLEANER_ID = person('second-cleaner').userId
const HANDYMAN_ID = person('maintenance').userId
const AGENT_ID = person('sales-agent').userId

/* -------------------------------------------------------------- tasks ---- */

type TaskPlan = {
  id: string
  taskType: string
  status: string
  priority: string
  title: string
  description: string | null
  unitId: string | null
  propertyId: string
  bookingId: string | null
  teamId: string
  assignedTo: string | null
  /** Day the work is scheduled for, as an offset from today. */
  onOffset: number
  startTime: string
  endTime: string
  estimatedMinutes: number
  requiresPhoto: boolean
}

const WINDOW_BEFORE = -13
const WINDOW_AFTER = 13

/** Alternating the two cleaners, so the board is a rota rather than a list. */
function cleanerFor(index: number): string {
  return index % 2 === 0 ? CLEANER_ID : SECOND_CLEANER_ID
}

const TASK_PLANS: TaskPlan[] = []

BOOKINGS.filter((booking) => booking.status !== 'cancelled').forEach(
  (booking) => {
    const checkoutOffset = booking.startOffset + booking.nights

    // ── Cleaning, on the morning of departure ──────────────────────────────
    if (checkoutOffset >= WINDOW_BEFORE && checkoutOffset <= WINDOW_AFTER) {
      const index = TASK_PLANS.length
      const status =
        checkoutOffset < 0
          ? index % 4 === 0
            ? 'completed'
            : 'verified'
          : checkoutOffset === 0
            ? 'in_progress'
            : 'assigned'

      TASK_PLANS.push({
        id: taskIds(index + 1),
        taskType: 'cleaning',
        status,
        priority: booking.unit.maxGuests >= 8 ? 'high' : 'normal',
        title: `ניקיון יציאה · ${booking.unit.name}`,
        description: `לאחר עזיבה ב-${day(checkoutOffset)}. ${booking.unit.bedrooms} חדרי שינה.`,
        unitId: booking.unit.id,
        propertyId: booking.unit.propertyId,
        bookingId: booking.id,
        teamId: TEAM_IDS.housekeeping,
        // A departure clean is always somebody's: the room has to be ready
        // before the next arrival, and an unassigned one is a room nobody is
        // cleaning.
        assignedTo: cleanerFor(index),
        onOffset: checkoutOffset,
        startTime: '11:00',
        endTime: booking.unit.maxGuests >= 8 ? '15:00' : '13:00',
        estimatedMinutes: booking.unit.maxGuests >= 8 ? 240 : 120,
        requiresPhoto: true,
      })
    }

    // ── Preparation, on the afternoon of arrival ───────────────────────────
    if (
      booking.startOffset >= WINDOW_BEFORE &&
      booking.startOffset <= WINDOW_AFTER
    ) {
      const index = TASK_PLANS.length
      const status =
        booking.startOffset < 0
          ? 'verified'
          : booking.startOffset === 0
            ? 'accepted'
            : 'new'

      TASK_PLANS.push({
        id: taskIds(index + 1),
        taskType: 'preparation',
        status,
        priority: booking.startOffset <= 1 ? 'high' : 'normal',
        title: `הכנת יחידה לקראת הגעה · ${booking.unit.name}`,
        description: `${booking.adults} מבוגרים, ${booking.children} ילדים, ${booking.infants} תינוקות.`,
        unitId: booking.unit.id,
        propertyId: booking.unit.propertyId,
        bookingId: booking.id,
        teamId: TEAM_IDS.housekeeping,
        assignedTo: status === 'new' ? null : cleanerFor(index),
        onOffset: booking.startOffset,
        startTime: '13:00',
        endTime: '15:00',
        estimatedMinutes: 90,
        requiresPhoto: false,
      })
    }
  },
)

/** Work that belongs to the building rather than to a guest. */
const STANDING_TASKS: readonly Omit<TaskPlan, 'id'>[] = [
  {
    taskType: 'maintenance',
    status: 'in_progress',
    priority: 'high',
    title: 'משאבת הבריכה מרעישה',
    description: 'רעש מתכתי מהמשאבה מאז שלשום. הוזמן טכנאי.',
    unitId: null,
    propertyId: PROPERTY_IDS.rimonim,
    bookingId: null,
    teamId: TEAM_IDS.maintenance,
    assignedTo: HANDYMAN_ID,
    onOffset: 0,
    startTime: '08:00',
    endTime: '12:00',
    estimatedMinutes: 180,
    requiresPhoto: true,
  },
  {
    taskType: 'maintenance',
    status: 'blocked',
    priority: 'normal',
    title: 'החלפת דוד שמש · חדר הגפן',
    description: 'הדוד מחליד. ממתין להצעת מחיר שנייה.',
    unitId: unit('RIM-04').id,
    propertyId: PROPERTY_IDS.rimonim,
    bookingId: null,
    teamId: TEAM_IDS.maintenance,
    assignedTo: HANDYMAN_ID,
    onOffset: 4,
    startTime: '09:00',
    endTime: '13:00',
    estimatedMinutes: 240,
    requiresPhoto: false,
  },
  {
    taskType: 'inspection',
    status: 'assigned',
    priority: 'normal',
    title: 'ביקורת רבעונית · וילה כחול ים',
    description: 'בדיקת כלים, מצעים, ריהוט גן ותאורת חוץ.',
    unitId: unit('KAY-01').id,
    propertyId: PROPERTY_IDS.kacholYam,
    bookingId: null,
    teamId: TEAM_IDS.maintenance,
    assignedTo: PROPERTY_MANAGER_ID,
    onOffset: 6,
    startTime: '10:00',
    endTime: '13:00',
    estimatedMinutes: 150,
    requiresPhoto: true,
  },
  {
    taskType: 'inventory',
    status: 'new',
    priority: 'low',
    title: 'ספירת מלאי חודשית',
    description: 'מצעים, מגבות, קפסולות וכלי מטבח בשני הנכסים.',
    unitId: null,
    propertyId: PROPERTY_IDS.rimonim,
    bookingId: null,
    teamId: TEAM_IDS.housekeeping,
    assignedTo: null,
    onOffset: 9,
    startTime: '09:00',
    endTime: '12:00',
    estimatedMinutes: 180,
    requiresPhoto: false,
  },
  {
    taskType: 'guest_request',
    status: 'cancelled',
    priority: 'normal',
    title: 'סידור פרחים ובקבוק יין · סוויטת התאנה',
    description: 'האורחים ביקשו לבטל — הגיעו עם יין משלהם.',
    unitId: unit('RIM-03').id,
    propertyId: PROPERTY_IDS.rimonim,
    bookingId: null,
    teamId: TEAM_IDS.frontDesk,
    assignedTo: RECEPTION_ID,
    onOffset: -1,
    startTime: '14:00',
    endTime: '15:00',
    estimatedMinutes: 30,
    requiresPhoto: false,
  },
]

STANDING_TASKS.forEach((plan) => {
  TASK_PLANS.push({ ...plan, id: taskIds(TASK_PLANS.length + 1) })
})

export const TASKS: readonly TaskPlan[] = TASK_PLANS

/**
 * A standing task's id, by the title it was written with.
 *
 * The generated ids depend on how many bookings fell inside the window, so
 * `taskIds(30)` is not a stable reference to the pool pump — it moves the first
 * time a stay is added. The approvals and the stock movements below have to
 * point at *these* jobs and not at whichever job happens to be thirtieth, so
 * they look them up by the sentence a person would recognise.
 *
 * Throws rather than returning undefined: a `task_id` of `undefined` in a
 * seeded row is a foreign key that silently becomes null, and the demo would
 * then show a repair with no cost and no explanation for the absence.
 */
function standingTaskId(title: string): string {
  const found = TASK_PLANS.find((task) => task.title === title)
  if (!found) {
    throw new Error(
      `No standing task titled '${title}' in dataset-operations.ts. The ` +
        `approvals and inventory movements below are attached to tasks by ` +
        `title, so renaming one there means renaming it here.`,
    )
  }
  return found.id
}

/** The two repairs and the inspection that carry money or stock below. */
const POOL_PUMP_TASK = standingTaskId('משאבת הבריכה מרעישה')
const BOILER_TASK = standingTaskId('החלפת דוד שמש · חדר הגפן')
const QUARTERLY_INSPECTION = standingTaskId('ביקורת רבעונית · וילה כחול ים')

export const TASK_ROWS: DemoRow[] = TASKS.map((task) => {
  const done = task.status === 'completed' || task.status === 'verified'
  return {
    id: task.id,
    organization_id: ORGANIZATION_ID,
    property_id: task.propertyId,
    unit_id: task.unitId,
    booking_id: task.bookingId,
    task_type: task.taskType,
    status: task.status,
    priority: task.priority,
    title: task.title,
    description: task.description,
    assigned_to_user_id: task.assignedTo,
    team_id: task.teamId,
    scheduled_start_at: momentOn(task.onOffset, task.startTime),
    scheduled_end_at: momentOn(task.onOffset, task.endTime),
    due_at: momentOn(task.onOffset, task.endTime),
    estimated_minutes: task.estimatedMinutes,
    actual_minutes: done ? task.estimatedMinutes - 15 : null,
    started_at:
      done || task.status === 'in_progress'
        ? momentOn(task.onOffset, task.startTime)
        : null,
    // `tasks_completed_has_moment`: a task that says it is done must say when.
    completed_at: done ? momentOn(task.onOffset, task.endTime) : null,
    verified_at:
      task.status === 'verified' ? momentOn(task.onOffset + 1, '09:00') : null,
    verified_by: task.status === 'verified' ? PROPERTY_MANAGER_ID : null,
    cancelled_at:
      task.status === 'cancelled' ? momentOn(task.onOffset, '12:00') : null,
    // Both of these are required by their status, and forbidden to be blank.
    blocked_reason:
      task.status === 'blocked' ? 'ממתין להצעת מחיר שנייה מהספק.' : null,
    cancellation_reason:
      task.status === 'cancelled' ? 'האורחים ביטלו את הבקשה.' : null,
    completion_note: done ? 'הועבר לבדיקה. אין ליקויים.' : null,
    requires_photo: task.requiresPhoto,
    metadata: {},
    ...stamped(MANAGER_ID, task.onOffset - 3),
  }
})

export const TASK_ASSIGNMENT_ROWS: DemoRow[] = TASKS.filter(
  (task) => task.assignedTo !== null,
).map((task, index) => ({
  id: assignmentIds(index + 1),
  organization_id: ORGANIZATION_ID,
  task_id: task.id,
  user_id: task.assignedTo as string,
  assignment_role: 'assignee',
  assigned_at: momentOn(task.onOffset - 2, '08:00'),
  assigned_by: MANAGER_ID,
  accepted_at:
    task.status === 'new' || task.status === 'assigned'
      ? null
      : momentOn(task.onOffset - 1, '18:30'),
  // `task_assignments_not_both`: accepted and declined cannot both be true.
  declined_at: null,
  declined_reason: null,
  unassigned_at: null,
  metadata: {},
  created_at: momentOn(task.onOffset - 2, '08:00'),
  updated_at: momentOn(task.onOffset - 2, '08:00'),
  version: 1,
}))

/** The steps of a departure clean, on the tasks that have them. */
const CHECKLIST_STEPS: readonly {
  label: string
  required: boolean
  photo: boolean
}[] = [
  { label: 'החלפת מצעים ומגבות', required: true, photo: false },
  { label: 'ניקוי מקלחת ושירותים', required: true, photo: true },
  { label: 'ריקון וניקוי מקרר', required: true, photo: false },
  { label: 'בדיקת כלים חסרים או שבורים', required: true, photo: false },
  { label: 'איוורור וסידור סופי', required: false, photo: true },
]

export const TASK_CHECKLIST_ROWS: DemoRow[] = TASKS.filter(
  (task) => task.taskType === 'cleaning',
)
  .slice(0, 8)
  .flatMap((task, taskIndex) => {
    const done = task.status === 'completed' || task.status === 'verified'
    return CHECKLIST_STEPS.map((step, stepIndex) => ({
      id: checklistIds(taskIndex * 10 + stepIndex + 1),
      organization_id: ORGANIZATION_ID,
      task_id: task.id,
      position: stepIndex,
      label: step.label,
      description: null,
      is_required: step.required,
      requires_photo: step.photo,
      is_done: done || (task.status === 'in_progress' && stepIndex < 2),
      done_at:
        done || (task.status === 'in_progress' && stepIndex < 2)
          ? momentOn(task.onOffset, task.startTime)
          : null,
      done_by:
        done || (task.status === 'in_progress' && stepIndex < 2)
          ? task.assignedTo
          : null,
      photo_url: null,
      note: null,
      metadata: {},
      created_at: momentOn(task.onOffset - 2, '08:00'),
      updated_at: momentOn(task.onOffset, task.startTime),
      version: 1,
    }))
  })

/* ---------------------------------------------------------- inventory ---- */

type ItemSeed = {
  sku: string
  name: string
  category: string
  quantity: number
  reserved: number
  min: number
  par: number
  costAgorot: number
  uom: string
  state: string
  propertyId: string
  unitCode: string | null
  location: string
}

const ITEM_SEEDS: readonly ItemSeed[] = [
  {
    sku: 'LIN-SHEET-Q',
    name: 'סט מצעים זוגי',
    category: 'מצעים',
    quantity: 34,
    reserved: 6,
    min: 12,
    par: 40,
    costAgorot: 11_000,
    uom: 'סט',
    state: 'available',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מחסן מצעים',
  },
  {
    sku: 'LIN-TOWEL-L',
    name: 'מגבת גוף',
    category: 'מגבות',
    quantity: 61,
    reserved: 12,
    min: 24,
    par: 80,
    costAgorot: 3_400,
    uom: 'יח׳',
    state: 'available',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מחסן מצעים',
  },
  {
    sku: 'LIN-TOWEL-L',
    name: 'מגבת גוף — בכביסה',
    category: 'מגבות',
    quantity: 18,
    reserved: 0,
    min: 0,
    par: 0,
    costAgorot: 3_400,
    uom: 'יח׳',
    state: 'laundry',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מכבסה חיצונית',
  },
  {
    sku: 'CON-COFFEE',
    name: 'קפסולות קפה',
    category: 'כיבוד',
    quantity: 240,
    reserved: 0,
    min: 100,
    par: 300,
    costAgorot: 250,
    uom: 'יח׳',
    state: 'available',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מזווה',
  },
  {
    sku: 'CON-WINE-LOC',
    name: 'יין מקומי — בקבוק קבלת פנים',
    category: 'כיבוד',
    quantity: 22,
    reserved: 4,
    min: 8,
    par: 24,
    costAgorot: 4_800,
    uom: 'בקבוק',
    state: 'available',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מזווה',
  },
  {
    sku: 'CON-TP',
    name: 'נייר טואלט',
    category: 'מתכלים',
    quantity: 96,
    reserved: 0,
    min: 48,
    par: 120,
    costAgorot: 180,
    uom: 'גליל',
    state: 'available',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מחסן כללי',
  },
  {
    sku: 'EQ-ROBE',
    name: 'חלוק רחצה',
    category: 'ציוד',
    quantity: 8,
    reserved: 2,
    min: 4,
    par: 10,
    costAgorot: 14_500,
    uom: 'יח׳',
    state: 'in_use',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: 'RIM-01',
    location: 'סוויטת הזית',
  },
  {
    sku: 'EQ-COT',
    name: 'מיטת תינוק מתקפלת',
    category: 'ציוד',
    quantity: 3,
    reserved: 1,
    min: 2,
    par: 4,
    costAgorot: 32_000,
    uom: 'יח׳',
    state: 'available',
    propertyId: PROPERTY_IDS.rimonim,
    unitCode: null,
    location: 'מחסן כללי',
  },
  {
    sku: 'LIN-SHEET-K',
    name: 'סט מצעים קינג',
    category: 'מצעים',
    quantity: 16,
    reserved: 4,
    min: 8,
    par: 20,
    costAgorot: 15_000,
    uom: 'סט',
    state: 'available',
    propertyId: PROPERTY_IDS.kacholYam,
    unitCode: null,
    location: 'מחסן הווילה',
  },
  {
    sku: 'EQ-POOL-NET',
    name: 'רשת ניקוי בריכה',
    category: 'ציוד',
    quantity: 1,
    reserved: 0,
    min: 1,
    par: 2,
    costAgorot: 9_000,
    uom: 'יח׳',
    state: 'damaged',
    propertyId: PROPERTY_IDS.kacholYam,
    unitCode: null,
    location: 'חדר מכונות',
  },
]

export const INVENTORY_ITEM_ROWS: DemoRow[] = ITEM_SEEDS.map((seed, index) => ({
  id: itemIds(index + 1),
  organization_id: ORGANIZATION_ID,
  property_id: seed.propertyId,
  unit_id: seed.unitCode === null ? null : unit(seed.unitCode).id,
  sku: seed.sku,
  name: seed.name,
  category: seed.category,
  description: null,
  state: seed.state,
  quantity: seed.quantity,
  quantity_reserved: seed.reserved,
  unit_of_measure: seed.uom,
  min_quantity: seed.min,
  par_level: seed.par,
  unit_cost_agorot: seed.costAgorot,
  location: seed.location,
  last_counted_at: momentOn(-31, '10:00'),
  metadata: {},
  ...stamped(PROPERTY_MANAGER_ID, -200),
}))

type MovementSeed = {
  item: number
  kind: string
  delta: number
  fromState: string | null
  toState: string | null
  reason: string
  offset: number
  /** The job that consumed it, when there was one. */
  taskId?: string
}

const MOVEMENT_SEEDS: readonly MovementSeed[] = [
  {
    item: 1,
    kind: 'receipt',
    delta: 12,
    fromState: null,
    toState: 'available',
    reason: 'קליטת משלוח מצעים חדש.',
    offset: -21,
  },
  {
    item: 2,
    kind: 'issue',
    delta: -6,
    fromState: 'available',
    toState: 'in_use',
    reason: 'חלוקה ליחידות לפני סוף שבוע עמוס.',
    offset: -9,
  },
  {
    item: 3,
    kind: 'transfer',
    delta: 18,
    fromState: 'dirty',
    toState: 'laundry',
    reason: 'העברה למכבסה.',
    offset: -2,
  },
  {
    item: 4,
    kind: 'issue',
    delta: -40,
    fromState: 'available',
    toState: 'in_use',
    reason: 'מילוי מלאי קפסולות ביחידות.',
    offset: -6,
  },
  {
    item: 5,
    kind: 'issue',
    delta: -3,
    fromState: 'available',
    toState: 'in_use',
    reason: 'בקבוקי קבלת פנים לשלוש הזמנות.',
    offset: -1,
  },
  {
    item: 6,
    kind: 'receipt',
    delta: 48,
    fromState: null,
    toState: 'available',
    reason: 'הזמנה חודשית מהספק.',
    offset: -13,
  },
  {
    item: 8,
    kind: 'return',
    delta: 1,
    fromState: 'in_use',
    toState: 'available',
    reason: 'מיטת תינוק חזרה מהבקתה.',
    offset: -4,
  },
  {
    item: 10,
    kind: 'loss',
    delta: -1,
    fromState: 'available',
    toState: 'damaged',
    reason: 'נמצאה שבורה בביקורת הרבעונית.',
    offset: -8,
    // The one movement written against a job. `inventory_movements.task_id`
    // exists so a repair can say what it consumed, and a maintenance screen
    // that reads it needs at least one row that actually does — otherwise the
    // "parts" column is a query nobody has ever seen return anything. The item
    // and the task are both at וילה כחול ים, which is what makes it a coherent
    // fact rather than a link that happens to satisfy a two-column key.
    taskId: QUARTERLY_INSPECTION,
  },
]

export const INVENTORY_MOVEMENT_ROWS: DemoRow[] = MOVEMENT_SEEDS.map(
  (seed, index) => {
    const item = ITEM_SEEDS[seed.item - 1]
    return {
      id: movementIds(index + 1),
      organization_id: ORGANIZATION_ID,
      property_id: item.propertyId,
      item_id: itemIds(seed.item),
      kind: seed.kind,
      // `inventory_movements_delta_nonzero`: a movement of nothing is not a
      // movement, and recording one would corrupt every running total.
      quantity_delta: seed.delta,
      from_state: seed.fromState,
      to_state: seed.toState,
      // `inventory_movements_transfer_units`: a transfer must name a side.
      from_unit_id: seed.kind === 'transfer' ? null : null,
      to_unit_id: seed.kind === 'transfer' ? unit('RIM-01').id : null,
      task_id: seed.taskId ?? null,
      booking_id: null,
      reason: seed.reason,
      occurred_at: momentOn(seed.offset, '14:00'),
      metadata: {},
      created_at: momentOn(seed.offset, '14:00'),
      created_by: CLEANER_ID,
    }
  },
)

/* ---------------------------------------------------------- approvals ---- */

/**
 * Three decisions somebody had to make, in three different states.
 *
 * `approvals_no_self_approval` is the reason each row names a different
 * decider from its requester — the database refuses to record somebody
 * approving their own discount, which is the control this table exists for.
 */
export const APPROVAL_ROWS: DemoRow[] = [
  {
    id: approvalIds(1),
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.rimonim,
    approval_type: 'discount',
    status: 'approved',
    booking_id: null,
    task_id: null,
    subject_type: null,
    subject_id: null,
    requested_by: AGENT_ID,
    requested_at: momentOn(-6, '11:20'),
    reason: 'לקוח חוזר שמזמין שלושה לילות באמצע השבוע. ביקש 12%.',
    requested_value_bps: 1200,
    limit_value_bps: 800,
    requested_agorot: null,
    limit_agorot: null,
    decided_by: MANAGER_ID,
    decided_at: momentOn(-6, '13:05'),
    decision_note: 'מאושר עד 10%, לא מעבר.',
    expires_at: null,
    metadata: {},
    created_at: momentOn(-6, '11:20'),
    updated_at: momentOn(-6, '13:05'),
    version: 2,
  },
  {
    id: approvalIds(2),
    organization_id: ORGANIZATION_ID,
    // אחוזת רימונים, because this is the quote for *that* pool's pump — the
    // task below is the noise somebody reported there. An approval about a
    // repair and the repair itself sitting in two different properties is the
    // kind of quiet inconsistency a demo teaches people to ignore.
    property_id: PROPERTY_IDS.rimonim,
    approval_type: 'expense',
    // Nobody has decided yet, so `decided_at` must stay null.
    status: 'requested',
    booking_id: null,
    task_id: POOL_PUMP_TASK,
    subject_type: null,
    subject_id: null,
    requested_by: PROPERTY_MANAGER_ID,
    requested_at: momentOn(-1, '16:40'),
    reason: 'החלפת משאבת בריכה — הצעה של 4,800 ₪ כולל התקנה.',
    requested_value_bps: null,
    limit_value_bps: null,
    requested_agorot: 480_000,
    limit_agorot: 200_000,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    expires_at: momentOn(6, '16:40'),
    metadata: {},
    created_at: momentOn(-1, '16:40'),
    updated_at: momentOn(-1, '16:40'),
    version: 1,
  },
  {
    id: approvalIds(3),
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.rimonim,
    approval_type: 'refund',
    status: 'rejected',
    booking_id: null,
    task_id: null,
    subject_type: null,
    subject_id: null,
    requested_by: RECEPTION_ID,
    requested_at: momentOn(-11, '09:15'),
    reason: 'האורח ביקש החזר על לילה אחרון שלא נוצל.',
    requested_value_bps: null,
    limit_value_bps: null,
    requested_agorot: 115_000,
    limit_agorot: 50_000,
    decided_by: OWNER_ID,
    decided_at: momentOn(-10, '08:30'),
    decision_note: 'מחוץ למדיניות הביטול. הוצע שובר לשהות עתידית במקום.',
    expires_at: null,
    metadata: {},
    created_at: momentOn(-11, '09:15'),
    updated_at: momentOn(-10, '08:30'),
    version: 2,
  },
  {
    /**
     * The one approval that is money already committed to a repair.
     *
     * `approval_type` is `maintenance`, which is in `APPROVAL_TYPES` and had no
     * row until now — so the maintenance screen's "approved cost" column had
     * nothing to read anywhere in the dataset, and a reader could not tell an
     * empty column from a broken query. The boiler it pays for is the task that
     * is `blocked` waiting for a second quote: the first quote was approved,
     * and the block is about the second. Those are consistent facts, not a
     * contradiction.
     */
    id: approvalIds(4),
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.rimonim,
    approval_type: 'maintenance',
    status: 'approved',
    booking_id: null,
    task_id: BOILER_TASK,
    subject_type: null,
    subject_id: null,
    requested_by: PROPERTY_MANAGER_ID,
    requested_at: momentOn(-9, '10:10'),
    reason: 'החלפת דוד שמש בחדר הגפן — הצעה של 6,200 ₪ כולל פירוק והתקנה.',
    requested_value_bps: null,
    limit_value_bps: null,
    requested_agorot: 620_000,
    limit_agorot: 200_000,
    // `approvals_no_self_approval`: the decider is never the requester.
    decided_by: OWNER_ID,
    decided_at: momentOn(-8, '09:40'),
    decision_note: 'מאושר. הדוד מחליד ואי אפשר להשכיר את החדר בלי מים חמים.',
    expires_at: null,
    metadata: {},
    created_at: momentOn(-9, '10:10'),
    updated_at: momentOn(-8, '09:40'),
    version: 2,
  },
]
