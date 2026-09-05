/**
 * ESTIA Autopilot — the intelligent operations layer.
 *
 * ── What it is ────────────────────────────────────────────────────────────
 *
 * Autopilot watches the operation ESTIA already runs, notices where the real
 * state has drifted from the expected one, decides what should be done about
 * it, and — inside guardrails the customer set and the platform can override —
 * does it.
 *
 * ── What it is not, and this is the load-bearing part ─────────────────────
 *
 * It is not a second automation engine. `src/lib/automation/engine.ts` already
 * validates events, refuses another tenant's, checks the package, checks the
 * grant per action, claims idempotency and writes audit. Autopilot sits ABOVE
 * that layer, not beside it:
 *
 *     canonical events
 *          ↓
 *     signals      what is wrong          (expected vs real)
 *          ↓
 *     decide       what matters, and why  (triage, root cause, proposals)
 *          ↓
 *     policy       may we, and how much   (five floors, narrowing only)
 *          ↓
 *     execute      through the SAME domain command a person's click uses
 *
 * Nothing in this module writes a business table. Every action names a
 * `command` in `actions.ts`, and that command is an existing `defineOperation`
 * — so validation, permissions, audit, events and invariants all still happen,
 * and "Autopilot did it" and "Dana did it" are the same kind of record with a
 * different actor. An action with no command is one that ends inside Autopilot
 * itself, and those are visible in the catalogue as `command: null`.
 *
 * It is also not a chatbot, not a second CRM, not a replacement booking engine
 * and not an unrestricted agent. It is a controlled intelligence and execution
 * layer over the canonical operating system, and the ceiling on what it may do
 * lives in `autopilot_safety_rules`, which no tenant role can write.
 *
 * ── Deterministic and judged, and the line between them ───────────────────
 *
 * Payment state, availability, deadlines, inventory arithmetic, permissions
 * and money are decided by the engines that already own them. Autopilot
 * consumes their conclusions as `Evidence` and never recomputes one: a second
 * opinion about whether a deposit was paid is not a feature.
 *
 * Interpretation, ordering, wording and pattern-noticing are where judgment is
 * allowed. `confidence` describes that judgment and never the underlying
 * facts — an arithmetic shortage is not "probably six towels".
 *
 * ── Earning it gradually ──────────────────────────────────────────────────
 *
 * advisory → assisted → autopilot, and a new organization starts in
 * `simulation` even if it chose `autopilot`, so a customer whose entitlement
 * was granted this morning cannot wake up to messages having been sent
 * overnight. Nobody has to surrender control to get the benefit.
 */

export * from './actions'
export * from './types'
