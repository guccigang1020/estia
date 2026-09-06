-- ============================================================================
-- 0047_autopilot_caused_by_is_immediate_parent.sql — ESTIA
--
-- What this corrects
--   0046 shipped a column comment on `autopilot_exceptions.caused_by` saying
--   it "Points at the ROOT, not at the previous alert." That is wrong, and it
--   contradicts the same module's TypeScript contract in
--   `src/lib/autopilot/types.ts`, which says the immediate cause.
--
--   The brief's own example is a four-level chain — laundry delay → clean
--   inventory shortage → preparation risk → arrival risk — and the point of it
--   is that the screen shows a CHAIN rather than four unrelated alarms at
--   06:00. Immediate-parent edges are what make that reconstructable. If every
--   row pointed at the root instead, the chain would flatten into a star: one
--   root and three consequences all at depth one, with the ordering between
--   them gone. The depth is the part a person reads to know what to fix first,
--   so losing it loses the feature.
--
-- How it was found
--   By the agent building the triage stage, which had to implement against
--   both readings because the two sources disagreed. A contradiction between
--   a schema comment and a type is the kind of thing that survives review
--   indefinitely, because each side looks right on its own.
--
-- Scope
--   Comment only. No data moves and no schema moves. The rehearsal asserts the
--   new text actually landed, because a `comment on` that silently addressed
--   the wrong object would leave the misleading text in place.
--
-- Depends on
--   0046 (the table).
-- ============================================================================

set search_path = public, extensions;

comment on column public.autopilot_exceptions.caused_by is
  'The IMMEDIATE cause — this row''s parent, never the ultimate root. A laundry delay causes a shortage causes a preparation risk causes an arrival risk, and parent edges are what let the screen show that as a chain; if every row pointed at the root the chain would flatten into a star and the depth would be lost. Deduplication stops repeats of one problem; this stops four different problems that are really one from arriving as four.';


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
begin
  if position('IMMEDIATE' in (
       select col_description('public.autopilot_exceptions'::regclass, a.attnum)
       from pg_attribute a
       where a.attrelid = 'public.autopilot_exceptions'::regclass
         and a.attname = 'caused_by')) = 0 then
    raise exception
      'the caused_by comment still describes a root pointer, and the triage stage reads it as a parent pointer';
  end if;
end $$;
