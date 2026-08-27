export {
  InMemoryActorSource,
  makeEffectivePlan,
  type ActorSourceCalls,
  type ActorWorld,
} from './memory-source'

export {
  grantsForAssignments,
  resolveActor,
  resolveActorOrThrow,
  scopeFromRow,
  type ActorResolution,
  type ActorResolutionFailure,
} from './resolve'

export type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
  RoleKind,
} from './source'
