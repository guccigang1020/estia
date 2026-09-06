-- ============================================================================
-- 0048_autopilot_per_action_safety_rule_semantics.sql — ESTIA
--
-- What this documents
--   A row in `autopilot_safety_rules` with `action_kind` set caps THAT ACTION,
--   and its `max_safety_level` is not consulted.
--
--   This is not how the engine read it before. It used to fold a per-action
--   rule in at that rule's own `max_safety_level`, which meant a row like
--
--     ('payment.refund', 'information', 'off', …)
--
--   bit only at the `information` level and therefore did nothing whatsoever
--   to `payment.refund`. A rule written after an incident, by somebody who
--   plainly meant "never do this again", was silently inert.
--
-- Why the action wins rather than both halves being honoured
--   Honouring both makes a row whose halves disagree do nothing — the single
--   worst outcome for a rule somebody writes at 02:00 after an incident. A
--   rule that is stricter than its author expected is recoverable in a
--   morning; a rule that quietly does not exist is found by the next
--   incident.
--
-- Why there is no CHECK tying them together
--   The database has no way to know an action's safety level. That catalogue
--   is `src/lib/autopilot/actions.ts`, and a second copy here would be a
--   second catalogue to migrate in step — the defect 0044 and 0046 both exist
--   to correct. So the column is documented as ignored rather than
--   constrained, and `max_safety_level` stays NOT NULL because the blanket
--   rule is the common case and needs it.
--
-- How it was found
--   By the agent implementing the per-action ceiling, which noticed the old
--   fold could not do what such a row obviously intends and said so rather
--   than implementing around it.
--
-- Scope
--   Comments only. No data and no schema move.
--
-- Depends on
--   0046 (the table).
-- ============================================================================

set search_path = public, extensions;

comment on column public.autopilot_safety_rules.action_kind is
  'Null means a BLANKET rule: every action at or above max_safety_level. Non-null names ONE action, and then max_safety_level is IGNORED — the rule caps that action, period. A row naming an action is what somebody writes after an incident with that specific thing, and requiring its two halves to agree would let a typo make it silently inert.';

comment on column public.autopilot_safety_rules.max_safety_level is
  'The level a BLANKET rule applies to. Not consulted when action_kind is set — see that column. Stays NOT NULL because the blanket rule is the common case; no CHECK ties it to the action, because the safety level of an action lives in src/lib/autopilot/actions.ts and a second copy here would be a second catalogue to migrate in step.';


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
begin
  if position('IGNORED' in (
       select col_description('public.autopilot_safety_rules'::regclass, a.attnum)
       from pg_attribute a
       where a.attrelid = 'public.autopilot_safety_rules'::regclass
         and a.attname = 'action_kind')) = 0 then
    raise exception
      'action_kind still does not say that max_safety_level is ignored for a per-action rule, which is how such a rule ends up silently inert';
  end if;
end $$;
