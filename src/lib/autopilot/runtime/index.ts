/**
 * The runtime: the layer that makes Autopilot run.
 *
 * `signals`, `decide`, `policy` and `execute` were four complete and tested
 * stages with no caller — an engine nobody started. This directory is the
 * ignition, and it holds no rules of its own:
 *
 *     handlers.ts   every catalogue command, bound to the real operation a
 *                   person's click calls — and the honest list of the ones
 *                   that have no port yet
 *     ports.ts      the fact sources detection runs on, and the four fact
 *                   shapes no table in this schema can supply
 *     context.ts    the five configuration tables, gathered into the one
 *                   record the safety engine reads
 *     run.ts        one pass: detect → decide → rule → execute
 *     wiring.ts     the request-scoped composition root
 *
 * ── `wiring.ts` is deliberately not re-exported here ──────────────────────
 *
 * It imports `@/lib/supabase/server`, which validates the environment at module
 * load and throws on a missing variable, and it reaches the `postgres` driver
 * through `@/lib/persistence`. A barrel that carried it would make importing a
 * type from this directory demand a Supabase project — which is exactly how the
 * database-free unit suite stops being able to load, and how a Client Component
 * ends up resolving `fs`. A server module that wants the composition root
 * imports `@/lib/autopilot/runtime/wiring` by name, where a reviewer sees it.
 * `src/lib/tasks/index.ts` makes the same argument about its own repository.
 */

export {
  UNWIRED_COMMANDS,
  autopilotCommandHandlers,
  type CommandHandlerPorts,
} from './handlers'

export {
  SupabaseFactPorts,
  UNSOURCED_FACTS,
  type AutopilotFactPorts,
  type FactScope,
  type StatedModules,
} from './ports'

export {
  SupabaseAutopilotPolicyRepository,
  gatherPolicyContext,
  grantsOf,
  type GatheredPolicy,
  type PolicyContextRequest,
} from './context'

export {
  runAutopilotPass,
  type AutopilotPassInput,
  type AutopilotPassReport,
  type RefusedDecision,
} from './run'
