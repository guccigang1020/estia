-- ============================================================================
-- 0043_notifications.sql — ESTIA · who is told, on what, and whether now
--
-- What this closes
--   `src/lib/contracts/events.ts` is a frozen catalogue of roughly 130 domain
--   events. Modules raise them. `ALERT_EVENTS` names the twelve that "must
--   reach a person rather than only a log". And nothing anywhere reaches a
--   person: there is no mailer, no SMS client, no WhatsApp client, no row that
--   remembers that somebody should have been told something. The bell in
--   `src/components/nav/top-bar.tsx` says so in its own comment — "there is no
--   notification system yet, so the panel says there is nothing".
--
--   A laundry order is rendered for a human to copy into WhatsApp by hand. A
--   guest is never told their booking was confirmed. A payment whose outcome
--   is unknown — the one state `events.ts` calls "a queue a person works, not
--   a log line" — sits in a table nobody is paged about.
--
-- ══ THIS MIGRATION DELIBERATELY BUILDS NO TRANSPORT ═════════════════════════
--
--   Email, SMS and WhatsApp each need a provider credential this project does
--   not have. Half a client behind a missing key is worse than none — that
--   decision was already made for payment proof storage and for
--   `payment_collection_settings.live_provider`, which holds a provider's NAME
--   and never a secret so the product can say "nothing is configured" without
--   reading one. The same decision, taken again, for the same reason.
--
--   So there is no credential column anywhere in this file. What there is
--   instead is `notification_deliveries.status = 'not_configured'`, which is a
--   first-class outcome and not an error: the routing engine decided somebody
--   should be told, chose a channel, and there was no transport behind it. A
--   business can then be shown "היינו שולחים 14 הודעות ואין ערוץ מחובר",
--   which is both honest and the strongest argument that exists for
--   connecting one. An empty table would have said nothing at all.
--
--   `in_app` is the exception and is fully delivered, because it needs no
--   credential: the `notifications` row IS the delivery, and the matching
--   `notification_deliveries` row is written `delivered` at the same moment.
--
-- ══ WHAT `memberships.notification_preferences` WAS, AND WHY IT IS NOT THIS ══
--
--   0001 gave `memberships` a `notification_preferences jsonb not null default
--   '{}'`. Nothing in the product has ever read it; the only writer is
--   `src/lib/demo/dataset-access.ts`, which seeds `{email: true, sms: …}` as
--   an illustration. It is NOT dropped here — it belongs to another table's
--   owner and ADD does not mean REPLACE — but it is superseded, and the reason
--   is worth stating because the blob looks adequate until it is asked a
--   question:
--
--     · Routing asks "who, among these eleven people, wants `payment.failed`
--       on SMS tonight". Against a blob that is eleven jsonb parses in the
--       application; against `notification_preferences` it is one indexed
--       read, which is the difference between a routing decision and a table
--       scan on every event.
--     · A blob cannot be constrained. `channel = 'whatsapp'` with
--       `min_severity = 'purple'` is storable in jsonb and is not storable
--       here.
--     · A blob has one `updated_at` for every preference it holds, so "who
--       turned off the payment alerts, and when" has no answer.
--
--   The migration that removes the column belongs to whoever owns 0001's
--   tables, once nothing reads it. This file does not read it either.
--
-- ══ SCOPE IS THE RULE THIS SCHEMA IS BUILT AROUND ═══════════════════════════
--
--   A PROPERTY MANAGER HOLDING TWO PROPERTIES IS NEVER TOLD ABOUT THE THIRD.
--
--   `notifications.property_id` is nullable and, when set, every read of the
--   row goes through `property_in_scope(property_id, organization_id)` — the
--   same function 0031 uses for collection overrides, mirroring
--   `isWithinScope()` in `src/lib/authz/can.ts`. The routing engine refuses
--   first, by calling `can()` with a resource carrying the property; the
--   policy refuses again, at the database, for the row that was written
--   anyway. Two independent floors, and the second one does not trust the
--   first.
--
--   `notifications.required_grant` is the third: the grant the recipient had
--   to hold for this notification to be routed to them at all. It is stored on
--   the row rather than re-derived, because a person whose role is narrowed
--   tomorrow must stop seeing yesterday's payment alert, and re-deriving it
--   from the event name would put the routing table in the database as well
--   as in `src/lib/notifications/catalogue.ts`. Two catalogues drift; one
--   does not.
--
-- ══ ONE EVENT, ONE NOTIFICATION, FOREVER ════════════════════════════════════
--
--   `notifications_dedupe_key` is UNIQUE on
--   `(organization_id, recipient_user_id, dedupe_key)`, and the key is derived
--   in `src/lib/notifications/dedupe.ts` from the event's own
--   `idempotencyKey` — which `contracts/events.ts` defines as "stable across
--   retries of the same logical event" — plus the recipient. The recipient is
--   in the key because one event legitimately produces N notifications, one
--   per person, and those must not collide with each other; the event's key is
--   in it because a webhook delivered three times is one event.
--
--   So a retried handler is a failed insert, not a second message. The
--   guarantee is the constraint, not the handler remembering to look first —
--   which is the same argument `0006_idempotency.sql` makes at length.
--
-- ══ QUIET HOURS SUPPRESS PUSH, NEVER THE RECORD ═════════════════════════════
--
--   A notification is always WRITTEN. Quiet hours decide whether a channel may
--   wake somebody at 23:40, and they apply to the channels that push — email,
--   SMS, WhatsApp, push — and never to `in_app`, which is pull: opening the
--   product at eight in the morning and finding what happened overnight is the
--   whole point of the in-app channel and is not an interruption.
--
--   `notification_settings.urgent_overrides_quiet_hours` defaults TRUE, and
--   the severities it covers are `urgent` and `critical`. A guesthouse whose
--   card processor is down at midnight is a business that wants to be woken.
--
-- ══ ESCALATION IS A ROW, NOT A CRON COMMENT ═════════════════════════════════
--
--   `notification_escalation_rules` says: this event, at this severity,
--   unacted for this many minutes, is raised again to this role. The raised
--   copy is an ordinary `notifications` row carrying `escalated_from` and
--   `escalation_level`, so the second message is as auditable, as
--   deduplicated and as scope-checked as the first. `escalation_level` is in
--   the dedupe key, which is why level 2 does not collide with level 1.
--
-- Depends on
--   0001 (organizations, memberships, tg_touch_row, organizations.timezone),
--   0002 (roles, role_permissions), 0004 (my_organizations, has_permission,
--   shares_organization_with), 0008 (properties, property_in_scope), 0012 +
--   0035 (the permission catalogue this deliberately does NOT extend — see
--   below), 0014 (the rule that a function in `public` is an API surface until
--   its grants say otherwise).
--
-- ══ NO NEW GRANT IS SEEDED, AND THAT IS DELIBERATE ══════════════════════════
--
--   0031 seeded `payment.policy_manage` because there was no existing right
--   that meant "decide how this business takes money". There is one here.
--   Choosing what the organization notifies about, and when it stays quiet, IS
--   an organization setting, and `organization.settings.edit` already names
--   it — exactly the argument `src/lib/authz/permissions.ts` makes for
--   preparation having no grants of its own ("a second name for a right
--   somebody already holds is a right that can be revoked in one place and
--   kept in the other").
--
--   A person's OWN preferences need no grant at all. They are their rows, and
--   the policies below say `user_id = (select auth.uid())` rather than asking
--   the catalogue a question whose answer would be the same for everyone.
--
--   If `notification.view` / `notification.manage` are later added to
--   `src/lib/authz/permissions.ts`, the three policies naming
--   `organization.settings.edit` are where they land, and nothing else in this
--   file changes.
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The vocabularies
-- ============================================================================
-- Every one of these is transcribed from `src/lib/notifications/types.ts`, in
-- the same order, and the order is load-bearing twice over: an enum's ordinal
-- is what `order by severity` sorts on, and `notification_severity` is
-- COMPARED — `severity >= min_severity` is how a preference filters, and that
-- comparison is the enum's ordinal and nothing else. Reordering these members
-- silently changes who gets woken up.

do $$ begin
  create type public.notification_channel as enum (
    -- First, and the only one this product actually delivers. Needs no
    -- credential, so it is the channel that works on the day a business signs
    -- up rather than the day it finishes an integration.
    'in_app',
    'email',
    'sms',
    'whatsapp',
    'push'
  );
exception when duplicate_object then null;
end $$;

comment on type public.notification_channel is
  'Transcribed from NOTIFICATION_CHANNELS in src/lib/notifications/types.ts, in the same order. `in_app` is first and is the only one with a working transport; the other four are declared so that a delivery attempt against them can be recorded as `not_configured`, which is what lets a business see what it is not sending.';

do $$ begin
  create type public.notification_severity as enum (
    'info',
    'attention',
    'urgent',
    'critical'
  );
exception when duplicate_object then null;
end $$;

comment on type public.notification_severity is
  'Transcribed from NOTIFICATION_SEVERITIES, in ascending order — and the order is the whole point: a preference stores a MINIMUM severity and the filter is `severity >= min_severity`, which is an ordinal comparison on this type. `urgent` and above are what urgent_overrides_quiet_hours lets through at midnight.';

do $$ begin
  create type public.notification_category as enum (
    'booking',
    'guest',
    'money',
    'operations',
    'inventory',
    'approval',
    'security',
    'system'
  );
exception when duplicate_object then null;
end $$;

comment on type public.notification_category is
  'Transcribed from NOTIFICATION_CATEGORIES. The unit a PERSON tunes: nobody wants a switch per domain event, and 130 switches is a preferences screen nobody finishes. The event-to-category map lives once, in src/lib/notifications/catalogue.ts, beside the frozen event names it reads.';

do $$ begin
  create type public.notification_delivery_status as enum (
    'pending',
    -- Quiet hours. Held, not dropped: `scheduled_for` says when it may go.
    'deferred',
    'sent',
    'delivered',
    'failed',
    -- THE state this module exists to make visible. Not an error.
    'not_configured',
    -- A preference, a severity floor or a capability said no.
    'suppressed'
  );
exception when duplicate_object then null;
end $$;

comment on type public.notification_delivery_status is
  'Transcribed from NOTIFICATION_DELIVERY_STATUSES. `not_configured` is a first-class outcome and never an error: the routing engine decided somebody should be told, chose a channel, and no transport exists behind it. A business is shown the count, which is the honest argument for connecting a channel. `suppressed` is different and must not be merged with it — that is a person having said no, and a screen that showed them as one number would be telling the business to buy something its own staff switched off.';


-- ============================================================================
-- 2 · notification_settings — the organization's own answer
-- ============================================================================
-- One row per organization. No row is not an error and is not a prompt: it
-- means the column defaults below, which are a complete and sensible
-- configuration — in-app on, everything else off because nothing is connected,
-- quiet hours 22:00–07:00 in the organization's own timezone, and urgent
-- alerts allowed through them.

create table if not exists public.notification_settings (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references public.organizations (id) on delete cascade,

  -- ── Which channels this business has at all ─────────────────────────────
  -- `in_app` alone, because on the day a business signs up that is the truth.
  -- A channel listed here is one the routing engine may plan a delivery on; a
  -- channel with no transport still records `not_configured` rather than
  -- vanishing, which is what makes the gap countable.
  enabled_channels            public.notification_channel[] not null
                                default '{in_app}'::public.notification_channel[],

  -- ── Quiet hours ─────────────────────────────────────────────────────────
  -- Local wall-clock times, evaluated in `timezone` below. Stored as `time`
  -- rather than as minutes-past-midnight because 22:00 is what a person types
  -- and an integer is what a bug looks like.
  quiet_hours_enabled         boolean not null default true,
  quiet_hours_start           time not null default '22:00',
  quiet_hours_end             time not null default '07:00',
  -- Defaults to the organization's own zone at write time. Kept as its own
  -- column rather than joined from `organizations`, because a business that
  -- moves its registered timezone must not silently move when its staff are
  -- allowed to be woken.
  timezone                    text not null default 'Asia/Jerusalem',
  -- A card processor down at midnight is a business that wants to be woken.
  urgent_overrides_quiet_hours boolean not null default true,

  -- ── Escalation ──────────────────────────────────────────────────────────
  -- The default used by a rule that names no interval of its own. Minutes,
  -- because that is the unit an operations manager reasons in.
  default_escalation_minutes  integer not null default 30,

  -- ── Housekeeping of the record itself ───────────────────────────────────
  -- How long a read notification stays in the inbox. Not a deletion policy for
  -- deliveries, which are evidence.
  retain_read_days            integer not null default 30,

  metadata                    jsonb not null default '{}'::jsonb,

  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users (id) on delete set null,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users (id) on delete set null,
  version                     integer not null default 1,

  constraint notification_settings_organization_key unique (organization_id),
  constraint notification_settings_timezone_not_blank check (length(btrim(timezone)) > 0),
  -- `in_app` needs no credential and is the only channel that always works.
  -- Removing it would leave a business with a routing engine and nowhere for
  -- its output to land, which reads on screen as "the product is broken".
  constraint notification_settings_in_app_always check (
    'in_app'::public.notification_channel = any (enabled_channels)
  ),
  -- Equal start and end would be a 24-hour quiet period, which is silence
  -- dressed as configuration.
  constraint notification_settings_quiet_window check (
    not quiet_hours_enabled or quiet_hours_start <> quiet_hours_end
  ),
  constraint notification_settings_escalation_range check (
    default_escalation_minutes >= 1 and default_escalation_minutes <= 10080
  ),
  constraint notification_settings_retain_range check (
    retain_read_days >= 1 and retain_read_days <= 3650
  ),
  constraint notification_settings_version_positive check (version >= 1)
);

comment on table public.notification_settings is
  'What this organization notifies about and when it stays quiet. One row per organization; no row means the column defaults, which are a complete configuration — in-app only, quiet 22:00 to 07:00 local, urgent alerts allowed through — and not an unfinished one.';
comment on column public.notification_settings.enabled_channels is
  'The channels the routing engine may plan a delivery on. A channel here with no transport behind it still produces a delivery row with status not_configured, which is deliberate: that count is the only honest way to show a business what it is failing to send.';
comment on column public.notification_settings.quiet_hours_start is
  'Local wall-clock, evaluated in this row''s own timezone. Quiet hours suppress the channels that PUSH and never in_app, which is pull — finding overnight events at eight in the morning is the point of the in-app channel, not an interruption.';
comment on column public.notification_settings.timezone is
  'Copied from organizations.timezone at first write and then owned here. Not a join, because a business changing its registered timezone must not silently change the hours at which its staff may be woken.';

drop trigger if exists notification_settings_touch on public.notification_settings;
create trigger notification_settings_touch
  before update on public.notification_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · notification_preferences — one person's answer, per category, per channel
-- ============================================================================
-- The grid a person actually tunes: eight categories by five channels. A
-- missing row is not "off" — it is "the module default", which
-- `src/lib/notifications/preferences.ts` resolves. That distinction is the
-- same one `MissingDemoTable` draws and it matters for the same reason: a
-- default that has never been touched must be changeable centrally, and a row
-- written for every pair at sign-up would freeze today's default into every
-- account forever.

create table if not exists public.notification_preferences (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  -- The person, not the membership. A membership is deleted-by-status rather
  -- than by row (0001: "status is the single removal mechanism"), so keying on
  -- the user is both simpler and survives a suspension and reinstatement.
  user_id             uuid not null references auth.users (id) on delete cascade,

  category            public.notification_category not null,
  channel             public.notification_channel not null,

  enabled             boolean not null default true,
  -- The floor. `info` means everything; `urgent` means "only wake me for the
  -- things that matter". Compared as an ordinal against notifications.severity
  -- — see the comment on the type.
  min_severity        public.notification_severity not null default 'info',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint notification_preferences_unique
    unique (organization_id, user_id, category, channel),
  constraint notification_preferences_version_positive check (version >= 1)
);

comment on table public.notification_preferences is
  'One person''s answer for one category on one channel, inside one organization. A missing row means the module default rather than "off" — so a default can still be changed centrally for everyone who has never expressed an opinion, which a row-per-pair at sign-up would have made impossible.';
comment on column public.notification_preferences.min_severity is
  'The floor this person accepts on this channel. Compared as an ordinal against notifications.severity, which is why the order of notification_severity is load-bearing rather than cosmetic.';
comment on column public.notification_preferences.organization_id is
  'Preferences are per-organization, not per-person. Somebody who cleans for one business and runs another wants SMS for one and silence from the other, and a single global preference cannot say that.';

drop trigger if exists notification_preferences_touch on public.notification_preferences;
create trigger notification_preferences_touch
  before update on public.notification_preferences
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · notifications — somebody should be told this
-- ============================================================================
-- One row per (event, recipient). Not per event: an event that concerns four
-- people is four rows, because "read" and "acted on" are facts about a person
-- and a shared row would make the first reader silence it for the other three.

create table if not exists public.notifications (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  -- Null for an organization-wide fact. Set for anything that happened at a
  -- property, and then it is what property_in_scope() is asked about on every
  -- single read of this row.
  property_id           uuid references public.properties (id) on delete cascade,

  recipient_user_id     uuid not null references auth.users (id) on delete cascade,

  -- ── What happened ───────────────────────────────────────────────────────
  -- Text and not an enum, deliberately. The catalogue is
  -- `src/lib/contracts/events.ts`, it is frozen there, it holds roughly 130
  -- names and it grows — and an enum here would be a SECOND catalogue that
  -- has to be migrated in step with the first. The check constrains the
  -- shape; the routing engine is what constrains the vocabulary, and it only
  -- ever writes names from DOMAIN_EVENTS because that is the type it takes.
  event_name            text not null,
  category              public.notification_category not null,
  severity              public.notification_severity not null default 'info',

  resource_type         text not null,
  resource_id           text,

  -- ── What the person reads ───────────────────────────────────────────────
  -- Composed at routing time and STORED, not re-rendered. A notification about
  -- a booking that has since been cancelled must still say what it said when
  -- it was raised — the same snapshot argument 0032 makes about an order line.
  title                 text not null,
  body                  text not null,
  -- Where the person goes to act. Relative, always: an absolute URL in a
  -- stored message is how a staging host ends up in a production e-mail.
  action_href           text,

  -- ── Why this person ─────────────────────────────────────────────────────
  -- The grant that had to be held for this to be routed here, stored rather
  -- than re-derived. Read again on every select (see the policy), so a person
  -- whose role is narrowed today stops seeing yesterday's payment alert.
  required_grant        text,

  -- ── Identity across retries ─────────────────────────────────────────────
  -- Derived in src/lib/notifications/dedupe.ts from the domain event's own
  -- idempotencyKey, the recipient and the escalation level. See the header.
  dedupe_key            text not null,
  correlation_id        uuid,
  -- When the thing HAPPENED, never when the handler ran. A retried
  -- notification must not claim the payment arrived an hour late.
  occurred_at           timestamptz not null,

  -- ── Escalation ──────────────────────────────────────────────────────────
  escalated_from        uuid references public.notifications (id) on delete set null,
  escalation_level      integer not null default 0,

  -- ── The person's own state ──────────────────────────────────────────────
  read_at               timestamptz,
  dismissed_at          timestamptz,
  -- Distinct from `read_at`: escalation asks "did anybody DO anything", and
  -- somebody opening a panel is not somebody paying an invoice.
  acted_at              timestamptz,

  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,

  constraint notifications_dedupe_key
    unique (organization_id, recipient_user_id, dedupe_key),
  constraint notifications_event_name_shape check (
    event_name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint notifications_title_not_blank check (length(btrim(title)) > 0),
  constraint notifications_body_not_blank check (length(btrim(body)) > 0),
  constraint notifications_resource_type_not_blank check (length(btrim(resource_type)) > 0),
  constraint notifications_dedupe_not_blank check (length(btrim(dedupe_key)) > 0),
  -- Relative only. See the column comment.
  constraint notifications_action_href_relative check (
    action_href is null or action_href like '/%'
  ),
  constraint notifications_escalation_level_range check (
    escalation_level >= 0 and escalation_level <= 10
  ),
  -- A level above zero without a parent is an escalation of nothing.
  constraint notifications_escalation_has_parent check (
    escalation_level = 0 or escalated_from is not null
  ),
  constraint notifications_version_positive check (version >= 1)
);

comment on table public.notifications is
  'Somebody should be told this. One row per (event, recipient) rather than per event, because read and acted-on are facts about a person: a shared row would let the first reader silence a payment failure for the other three people who also needed it.';
comment on column public.notifications.event_name is
  'A name from DOMAIN_EVENTS in src/lib/contracts/events.ts. Text rather than an enum on purpose — that catalogue is frozen there, holds roughly 130 names and grows, and a second copy as a Postgres enum is a second catalogue to migrate in step. The check constrains the shape; the routing engine constrains the vocabulary, because DomainEventName is the only type it accepts.';
comment on column public.notifications.required_grant is
  'The grant the recipient had to hold for this to be routed to them. Stored rather than re-derived so that narrowing somebody''s role today hides yesterday''s alert, and read again by notifications_select — the routing engine refusing is the first floor, this policy is the second, and the second does not trust the first.';
comment on column public.notifications.dedupe_key is
  'Unique per (organization, recipient). Derived from the event''s own idempotencyKey — which contracts/events.ts defines as stable across retries — plus the recipient and the escalation level. A retried handler is therefore a failed insert rather than a second message, and the guarantee is this constraint rather than a handler remembering to look first.';
comment on column public.notifications.acted_at is
  'Somebody DID the thing. Deliberately not read_at: escalation asks whether anybody acted, and opening a panel is not paying an invoice. A rule that escalated on read_at would fall silent the moment somebody glanced at their bell.';
comment on column public.notifications.title is
  'Composed at routing time and stored, never re-rendered from the resource. An alert about a booking that has since been cancelled must still say what it said when it was raised — the same reason store_order_lines snapshots an item name.';

drop trigger if exists notifications_touch on public.notifications;
create trigger notifications_touch
  before update on public.notifications
  for each row execute function public.tg_touch_row();

-- The inbox read: this person, this organization, newest first, unread first.
create index if not exists notifications_recipient_idx
  on public.notifications (organization_id, recipient_user_id, occurred_at desc);

-- What escalation sweeps: unacted, by severity, oldest first. Partial, because
-- the acted-on rows are the overwhelming majority within a day and the sweep
-- never looks at them.
create index if not exists notifications_unacted_idx
  on public.notifications (organization_id, severity, occurred_at)
  where acted_at is null and dismissed_at is null;

create index if not exists notifications_property_idx
  on public.notifications (organization_id, property_id)
  where property_id is not null;

create index if not exists notifications_event_idx
  on public.notifications (organization_id, event_name, occurred_at desc);


-- ============================================================================
-- 5 · notification_deliveries — what was attempted, on which channel
-- ============================================================================
-- The evidence table, and the one that answers "we would have sent 14
-- messages and there is no channel connected". Every planned delivery gets a
-- row, including the ones that were never going to leave the building — that
-- is the whole design, because a table that only recorded successes would show
-- an empty screen to the business with the biggest problem.

create table if not exists public.notification_deliveries (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  notification_id       uuid not null references public.notifications (id) on delete cascade,

  channel               public.notification_channel not null,
  status                public.notification_delivery_status not null default 'pending',
  attempt               integer not null default 1,

  -- Set when quiet hours held this back. The time it becomes sendable, in UTC
  -- — the wall-clock arithmetic happens once, in
  -- src/lib/notifications/quiet-hours.ts, and what is stored is the answer.
  scheduled_for         timestamptz,

  -- ── What the transport said ─────────────────────────────────────────────
  -- Never a credential and never a recipient address: the address belongs to
  -- the person, is read at send time, and storing it here would make this
  -- table a copy of every staff phone number in the business for no purpose
  -- the screens have.
  provider              text,
  provider_message_id   text,
  error_code            text,
  error_detail          text,
  -- Why nothing was sent, in the module's own vocabulary — `quiet_hours`,
  -- `preference_off`, `below_min_severity`, `channel_disabled`,
  -- `no_transport`. Rendered by src/lib/notifications/labels.ts; kept as text
  -- rather than an enum because it is a diagnostic, not a lifecycle, and a
  -- new reason must not need a migration to be recordable.
  suppressed_reason     text,

  attempted_at          timestamptz,
  settled_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,

  constraint notification_deliveries_attempt_unique
    unique (notification_id, channel, attempt),
  constraint notification_deliveries_attempt_positive check (attempt >= 1),
  -- A deferral with no time is a message that never goes.
  constraint notification_deliveries_deferred_has_time check (
    status <> 'deferred'::public.notification_delivery_status
    or scheduled_for is not null
  ),
  -- A suppression with no stated reason is a silence nobody can explain, and
  -- explaining it is the entire value of the screen that reads this table.
  constraint notification_deliveries_suppressed_has_reason check (
    status <> 'suppressed'::public.notification_delivery_status
    or (suppressed_reason is not null and length(btrim(suppressed_reason)) > 0)
  ),
  constraint notification_deliveries_failed_has_code check (
    status <> 'failed'::public.notification_delivery_status
    or (error_code is not null and length(btrim(error_code)) > 0)
  ),
  constraint notification_deliveries_version_positive check (version >= 1)
);

comment on table public.notification_deliveries is
  'One row per planned delivery, including every one that was never going to leave the building. A table that recorded only successes would show an empty screen to the business with the biggest problem — so not_configured, suppressed and deferred are rows here, and their count is what the settings screen reports.';
comment on column public.notification_deliveries.status is
  'not_configured means the engine chose this channel and no transport exists behind it — a first-class outcome, not an error. suppressed means a person or a policy said no. They are never merged: telling a business to buy a channel its own staff switched off would be the product arguing against its users.';
comment on column public.notification_deliveries.provider is
  'The transport''s name, and never a credential — the same rule as payment_collection_settings.live_provider. Keys live in the secret store; this column exists so a screen can say which transport answered without reading one.';
comment on column public.notification_deliveries.suppressed_reason is
  'Why nothing was sent, in the module''s vocabulary: quiet_hours, preference_off, below_min_severity, channel_disabled, no_transport. Text rather than an enum because it is a diagnostic rather than a lifecycle, and a new reason must not require a migration before it can be written down.';

drop trigger if exists notification_deliveries_touch on public.notification_deliveries;
create trigger notification_deliveries_touch
  before update on public.notification_deliveries
  for each row execute function public.tg_touch_row();

create index if not exists notification_deliveries_notification_idx
  on public.notification_deliveries (notification_id, channel);

-- What the settings screen counts: this organization, by status, recently.
create index if not exists notification_deliveries_status_idx
  on public.notification_deliveries (organization_id, status, created_at desc);

-- The queue a future transport would drain. Partial and tiny by construction.
create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries (organization_id, scheduled_for)
  where status in (
    'pending'::public.notification_delivery_status,
    'deferred'::public.notification_delivery_status
  );


-- ============================================================================
-- 6 · notification_escalation_rules — when nobody acts
-- ============================================================================
-- The half of the module that has no screen yet and is the reason the module
-- is worth having: a payment whose outcome is unknown, raised at 02:00 to a
-- reception clerk who is asleep, must reach the manager by 02:30 rather than
-- be found at nine.
--
-- A rule names a role, never a person. Naming a person is how an escalation
-- path dies quietly when they leave.

create table if not exists public.notification_escalation_rules (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,

  -- Null means "every event at or above min_severity", which is the rule most
  -- businesses actually want and would otherwise have to write 130 times.
  event_name            text,
  min_severity          public.notification_severity not null default 'urgent',

  -- Null falls back to notification_settings.default_escalation_minutes.
  after_minutes         integer,

  -- Whom to raise it to. A role code from `roles`, resolved to people at sweep
  -- time — so somebody joining the role inherits the escalation path and
  -- somebody leaving it stops being paged for a business they left.
  escalate_to_role_code text not null,
  max_level             integer not null default 2,
  enabled               boolean not null default true,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,

  constraint notification_escalation_rules_event_shape check (
    event_name is null
    or event_name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint notification_escalation_rules_after_range check (
    after_minutes is null or (after_minutes >= 1 and after_minutes <= 10080)
  ),
  constraint notification_escalation_rules_role_not_blank check (
    length(btrim(escalate_to_role_code)) > 0
  ),
  constraint notification_escalation_rules_max_level_range check (
    max_level >= 1 and max_level <= 10
  ),
  constraint notification_escalation_rules_version_positive check (version >= 1)
);

comment on table public.notification_escalation_rules is
  'When nobody acts, tell somebody else. A rule names a ROLE and never a person: naming a person is how an escalation path dies quietly the month they leave. A null event_name means every event at or above min_severity, which is the rule most businesses want and would otherwise have to write once per event name.';
comment on column public.notification_escalation_rules.after_minutes is
  'Null falls back to notification_settings.default_escalation_minutes, so an organization can move every unqualified rule at once instead of editing each.';

drop trigger if exists notification_escalation_rules_touch on public.notification_escalation_rules;
create trigger notification_escalation_rules_touch
  before update on public.notification_escalation_rules
  for each row execute function public.tg_touch_row();

create index if not exists notification_escalation_rules_lookup_idx
  on public.notification_escalation_rules (organization_id, enabled, min_severity);


-- ============================================================================
-- 7 · Row level security
-- ============================================================================

alter table public.notification_settings         enable row level security;
alter table public.notification_settings         force  row level security;
alter table public.notification_preferences      enable row level security;
alter table public.notification_preferences      force  row level security;
alter table public.notifications                 enable row level security;
alter table public.notifications                 force  row level security;
alter table public.notification_deliveries       enable row level security;
alter table public.notification_deliveries       force  row level security;
alter table public.notification_escalation_rules enable row level security;
alter table public.notification_escalation_rules force  row level security;

revoke all on public.notification_settings         from anon, authenticated;
revoke all on public.notification_preferences      from anon, authenticated;
revoke all on public.notifications                 from anon, authenticated;
revoke all on public.notification_deliveries       from anon, authenticated;
revoke all on public.notification_escalation_rules from anon, authenticated;

grant select, insert, update on public.notification_settings to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update on public.notifications to authenticated;
grant select, insert, update on public.notification_deliveries to authenticated;
grant select, insert, update, delete on public.notification_escalation_rules to authenticated;

grant select, insert, update on public.notification_settings to service_role;
grant select, insert, update, delete on public.notification_preferences to service_role;
grant select, insert, update on public.notifications to service_role;
grant select, insert, update on public.notification_deliveries to service_role;
grant select, insert, update, delete on public.notification_escalation_rules to service_role;

-- Two tables are never deleted from, by anybody, and the difference is what
-- the row means. A preference and an escalation rule are configuration: taking
-- one away is the honest way to undo it. A notification and its delivery
-- attempts are the record that somebody was — or notably was not — told, and
-- the second of those is the whole argument for connecting a channel. A
-- business must not be able to make its own unsent-message count go down by
-- deleting the evidence. Dismissal is a timestamp, and retention is
-- `retain_read_days` applied by a sweep that has yet to be written.
revoke delete, truncate on public.notifications           from authenticated, service_role;
revoke delete, truncate on public.notification_deliveries from authenticated, service_role;


-- ── notification_settings ───────────────────────────────────────────────────
-- Readable by anybody in the organization: every screen that explains why a
-- message was held until morning has to be able to name the quiet hours, and
-- the row holds no secret. Writable with `organization.settings.edit`, which
-- is what choosing them actually is.

drop policy if exists notification_settings_select on public.notification_settings;
create policy notification_settings_select on public.notification_settings
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists notification_settings_insert on public.notification_settings;
create policy notification_settings_insert on public.notification_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  );

drop policy if exists notification_settings_update on public.notification_settings;
create policy notification_settings_update on public.notification_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  );


-- ── notification_preferences ────────────────────────────────────────────────
-- Your own rows and nobody else's, in an organization you are actually in.
-- Deliberately not gated on a grant: a preference is not an authority, and
-- asking the catalogue a question whose answer is the same for every member is
-- a check that exists only to look thorough.
--
-- Note there is no administrator override. Somebody with
-- `organization.settings.edit` can turn a channel off for the whole business —
-- that is `notification_settings.enabled_channels` — and cannot reach inside
-- one person's grid and switch their SMS back on. Changing what somebody else
-- has chosen to receive, without their knowing, is not an administrative act.

drop policy if exists notification_preferences_select on public.notification_preferences;
create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  );

drop policy if exists notification_preferences_insert on public.notification_preferences;
create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  );

drop policy if exists notification_preferences_update on public.notification_preferences;
create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  )
  with check (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  );

drop policy if exists notification_preferences_delete on public.notification_preferences;
create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  );


-- ── notifications ───────────────────────────────────────────────────────────
-- THE POLICY THIS WHOLE MIGRATION IS BUILT AROUND.
--
-- Three conditions, and every one of them has to hold on every single read:
--
--   1. the tenant, as everywhere;
--   2. it is addressed to YOU. Not to your role, not to your team — a
--      notification is one person's;
--   3. it is still in your reach. `property_in_scope` is asked again on every
--      select rather than trusted from the moment of routing, so a manager
--      narrowed from three properties to two stops seeing the third's alerts
--      the moment the scope row changes — including the ones already in their
--      inbox.
--
-- `required_grant` is deliberately NOT re-checked here. `has_permission` is a
-- coarse mirror that knows nothing of plan entitlements or per-family scope
-- overrides (0004 says so in its own comment), and a policy that half-checked
-- the grant would be a second, weaker opinion sitting beside `can()`. The
-- column is read by src/lib/notifications/visibility.ts, which asks the real
-- engine. The database's job here is the tenant and the property, which it can
-- answer completely.

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and recipient_user_id = (select auth.uid())
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
  );

-- Written FOR somebody else, by whoever's session the raising operation ran
-- in. `shares_organization_with` is the check that stops a member of one
-- organization from addressing a notification to a stranger — the recipient
-- must be somebody this organization actually employs.
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.shares_organization_with(recipient_user_id)
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
  );

-- Only the recipient marks their own notification read, dismissed or acted on.
-- Nobody else may touch the row at all — an alert somebody else can silence on
-- your behalf is an alert you cannot rely on.
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and recipient_user_id = (select auth.uid())
  )
  with check (
    organization_id in (select public.my_organizations())
    and recipient_user_id = (select auth.uid())
  );


-- ── notification_deliveries ─────────────────────────────────────────────────
-- Two readers, and they are reading different things. The recipient sees the
-- delivery state of their own notification — "we tried to SMS you and there is
-- no SMS". Whoever configures the organization sees all of it, because the
-- aggregate is the argument for connecting a channel and an aggregate over
-- one's own rows is not an argument.

drop policy if exists notification_deliveries_select on public.notification_deliveries;
create policy notification_deliveries_select on public.notification_deliveries
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'organization.settings.edit')
      or exists (
        select 1
        from public.notifications n
        where n.id = notification_deliveries.notification_id
          and n.recipient_user_id = (select auth.uid())
      )
    )
  );

-- Written by whoever's session raised the notification, and only against a
-- notification of theirs — the subquery is what stops a delivery row being
-- attached to another organization's notification by id.
drop policy if exists notification_deliveries_insert on public.notification_deliveries;
create policy notification_deliveries_insert on public.notification_deliveries
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and exists (
      select 1
      from public.notifications n
      where n.id = notification_deliveries.notification_id
        and n.organization_id = notification_deliveries.organization_id
    )
  );

-- A deferred delivery becomes sent when its window opens, and a pending one
-- settles. That is the only reason this is updatable at all.
drop policy if exists notification_deliveries_update on public.notification_deliveries;
create policy notification_deliveries_update on public.notification_deliveries
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  );


-- ── notification_escalation_rules ───────────────────────────────────────────
-- Readable by the organization, because a person who wants to know why they
-- were paged at 02:30 deserves to be able to see the rule that did it.

drop policy if exists notification_escalation_rules_select on public.notification_escalation_rules;
create policy notification_escalation_rules_select on public.notification_escalation_rules
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists notification_escalation_rules_insert on public.notification_escalation_rules;
create policy notification_escalation_rules_insert on public.notification_escalation_rules
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  );

drop policy if exists notification_escalation_rules_update on public.notification_escalation_rules;
create policy notification_escalation_rules_update on public.notification_escalation_rules
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  );

drop policy if exists notification_escalation_rules_delete on public.notification_escalation_rules;
create policy notification_escalation_rules_delete on public.notification_escalation_rules
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'organization.settings.edit')
  );


-- ============================================================================
-- 8 · Rehearsal
-- ============================================================================
-- Everything above, asserted against the catalogue rather than assumed. This
-- block is the reason `0043` can be handed to somebody else to apply: it fails
-- loudly on the migration that half-landed, which is the failure mode a
-- `create table if not exists` file is most prone to.

do $$
declare
  missing text;
begin
  -- The five tables.
  select string_agg(name, ', ') into missing
  from (values
    ('notification_settings'), ('notification_preferences'),
    ('notifications'), ('notification_deliveries'),
    ('notification_escalation_rules')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;

  if missing is not null then
    raise exception 'tables missing for 0043: %', missing;
  end if;

  -- The four vocabularies.
  select string_agg(name, ', ') into missing
  from (values
    ('notification_channel'), ('notification_severity'),
    ('notification_category'), ('notification_delivery_status')
  ) as t(name)
  where to_regtype('public.' || t.name) is null;

  if missing is not null then
    raise exception 'types missing for 0043: %', missing;
  end if;

  -- The severity ordinals ARE the preference filter. If somebody ever
  -- reorders this enum, `severity >= min_severity` silently starts waking
  -- different people, and no test above the database would notice.
  if (enum_range(null::public.notification_severity))[1] <> 'info'
     or (enum_range(null::public.notification_severity))[4] <> 'critical' then
    raise exception
      'notification_severity is not ascending info..critical, so severity >= min_severity no longer means what every preference row assumes';
  end if;

  -- The dedupe constraint. Without it a retried handler sends twice, which is
  -- the single failure this module is most likely to have in production and
  -- the least likely to be noticed in a test.
  if not exists (
    select 1 from pg_constraint
    where conname = 'notifications_dedupe_key'
      and conrelid = 'public.notifications'::regclass
  ) then
    raise exception
      'notifications_dedupe_key is missing, so one event can produce two notifications';
  end if;

  -- Not a credential column anywhere. The whole premise of this migration is
  -- that no transport is configured here, and a column that could hold a
  -- provider key is how that premise quietly stops being true.
  select string_agg(c.relname || '.' || a.attname, ', ') into missing
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname like 'notification%'
    and c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped
    and (a.attname like '%secret%'
         or a.attname like '%token%'
         or a.attname like '%api_key%'
         or a.attname like '%credential%'
         or a.attname like '%password%');

  if missing is not null then
    raise exception
      '0043 carries credential columns and must not — transports are not configured here: %', missing;
  end if;

  -- RLS enabled AND forced on all five. Forced is the half people forget, and
  -- without it the table owner reads every tenant's notifications.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'notification_settings', 'notification_preferences', 'notifications',
      'notification_deliveries', 'notification_escalation_rules'
    )
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  -- `anon` holds nothing. A guest link must never reach a staff inbox.
  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name like 'notification%';

  if missing is not null then
    raise exception 'anon still holds privileges on: %', missing;
  end if;

  -- The record is append-and-amend, never erasable. A business must not be
  -- able to shrink its own unsent-message count by deleting the evidence.
  --
  -- Scoped to the three API roles on purpose. The table OWNER keeps DELETE the
  -- way it keeps everything, and a check that did not name the grantees would
  -- fail on the owner's own row — which is a rehearsal that cries wolf on
  -- every clean run and therefore stops being read.
  select string_agg(distinct table_name || ' → ' || grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('notifications', 'notification_deliveries')
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('DELETE', 'TRUNCATE');

  if missing is not null then
    raise exception 'delete is still granted on the notification record: %', missing;
  end if;

  -- The four touch triggers, so `updated_at` is not a column the application
  -- is trusted to remember.
  select string_agg(name, ', ') into missing
  from (values
    ('notification_settings_touch'), ('notification_preferences_touch'),
    ('notifications_touch'), ('notification_deliveries_touch'),
    ('notification_escalation_rules_touch')
  ) as t(name)
  where not exists (
    select 1 from pg_trigger where tgname = t.name and not tgisinternal
  );

  if missing is not null then
    raise exception 'triggers missing for 0043: %', missing;
  end if;
end $$;
