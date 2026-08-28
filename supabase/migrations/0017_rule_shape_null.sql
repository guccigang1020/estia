-- ============================================================================
-- 0017_rule_shape_null.sql — ESTIA · a CHECK that returned NULL was passing
--
-- What this fixes
--   0015 guarded the shape of a commission rule so that a rule nobody can
--   evaluate cannot be stored — the failure mode being a rule that silently
--   pays nothing:
--
--       when 'percentage' then jsonb_typeof(rule -> 'percent') = 'number'
--
--   That is right when the key is there and wrong when it is not.
--   `rule -> 'percent'` on a missing key is SQL NULL, `jsonb_typeof(NULL)` is
--   NULL, `NULL = 'number'` is NULL — and a CHECK constraint accepts NULL. It
--   only refuses an expression that evaluates to false. So
--
--       {"kind":"percentage"}
--
--   with no percentage at all was stored happily, which is exactly the row the
--   constraint existed to refuse.
--
--   supabase/tests/agents.sql caught it on the first run:
--
--       'a percentage rule with no percent is refused'
--         expected 23514, actual NO ERROR — A PERCENTAGE RULE WITH NO PERCENT
--
--   The two assertions on either side of it passed, which is what made the
--   hole narrow enough to be easy to miss by reading: an unknown `kind` was
--   refused (the CASE falls to ELSE false) and a tiered rule with an empty
--   `tiers` array was refused (`jsonb_array_length` really is 0). Only the
--   absent-key path went through NULL.
--
--   Every branch is wrapped in `coalesce(..., '')` here, so a missing key is a
--   value that fails the comparison instead of a NULL that skips it. The same
--   correction is applied to the `kind` checks on both tables: `rule ->> 'kind'
--   in (...)` is also NULL when the key is absent.
--
-- The general shape of the mistake, worth stating once
--   A CHECK is not "must be true"; it is "must not be false". Any expression
--   over a jsonb field that might be absent has to say what absence means, or
--   it silently permits the row.
--
-- Depends on
--   0015 (agent_commission_rules, agency_agreements).
-- ============================================================================

set search_path = public, extensions;

alter table public.agent_commission_rules
  drop constraint if exists agent_commission_rules_rule_kind;
alter table public.agent_commission_rules
  add constraint agent_commission_rules_rule_kind check (
    coalesce(rule ->> 'kind', '') in ('none', 'percentage', 'fixed', 'tiered')
  );

alter table public.agent_commission_rules
  drop constraint if exists agent_commission_rules_rule_shape;
alter table public.agent_commission_rules
  add constraint agent_commission_rules_rule_shape check (
    case coalesce(rule ->> 'kind', '')
      when 'none'       then true
      when 'percentage' then coalesce(jsonb_typeof(rule -> 'percent'), '') = 'number'
      when 'fixed'      then coalesce(jsonb_typeof(rule -> 'amountAgorot'), '') = 'number'
      when 'tiered'     then coalesce(jsonb_typeof(rule -> 'tiers'), '') = 'array'
                             and coalesce(jsonb_array_length(rule -> 'tiers'), 0) > 0
                             and coalesce(rule ->> 'mode', '') in ('marginal', 'whole')
      else false
    end
  );

comment on column public.agent_commission_rules.rule is
  'The CommissionRule union from src/lib/agents/commission.ts. Its shape is checked, and checked through coalesce: a CHECK refuses only what evaluates to false, so an absent key that yields NULL would otherwise be accepted — which is how a percentage rule with no percentage got stored before 0017.';

alter table public.agency_agreements
  drop constraint if exists agency_agreements_rule_kind;
alter table public.agency_agreements
  add constraint agency_agreements_rule_kind check (
    coalesce(rule ->> 'kind', '') in ('none', 'percentage', 'fixed', 'tiered')
  );

-- The same reading applied to 0016's formula guard. `expense_rules_formula_kind`
-- was already NULL-safe by accident — it is written as `formula is null or ...`,
-- so an absent `kind` inside a present formula was the gap, and it is closed
-- the same way.
alter table public.expense_rules
  drop constraint if exists expense_rules_formula_kind;
alter table public.expense_rules
  add constraint expense_rules_formula_kind check (
    formula is null
    or coalesce(formula ->> 'kind', '') in
       ('per_night', 'per_guest_night', 'per_booking', 'per_guest', 'percent_of_revenue')
  );
