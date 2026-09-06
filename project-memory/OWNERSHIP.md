# Ownership register

Who may write which files, while parallel work is in flight.

## Why this file exists

Ownership used to live in the briefs — a paragraph each agent read once and
then held in its own head. That is not a boundary, it is an intention, and it
failed twice in one day: a `git add -A` swept another agent's half-written
files into an unrelated commit, and one agent landed an import of a module a
second agent had not written yet, which broke every page of the application for
everyone including the user's running dev server.

Both failures share a shape. Nothing _checked_. The rule existed, everyone
meant to follow it, and there was no moment at which a machine said "these two
claims overlap" or "this file has no owner".

So the register is a file, it is the single source every brief is derived from,
and `npm run ownership` reads it and answers against the actual working tree.

## How to read a row

| column  | meaning                                                             |
| ------- | ------------------------------------------------------------------- |
| `path`  | a glob, matched against repo-relative paths                         |
| `owner` | the one worker that may **write** there                             |
| `mode`  | `write` — may create, edit, delete · `read` — may read, never write |

A path with no matching row has **no owner**, and a file changed under it is
reported. That is deliberate: an unclaimed edit is exactly how the two failures
above began.

Two rows may not claim the same path in `write` mode. The checker refuses that
before any agent starts, because a collision found after the fact is a merge
argument and a collision found before is a one-line edit to this file.

`coordinator` is me, the session driving the work. Shared files live there on
purpose — not because agents cannot be trusted with them, but because a file
every screen must touch is a queue, and a queue needs one server.

## The register

<!-- OWNERSHIP:BEGIN -->

```
# path                                       owner                mode

# ── Shared. One writer, always. ───────────────────────────────────────────
#
# The permission catalogue and the role presets belong to `authz`, and for
# this wave they are claimed here instead. Five workers all need grants added
# in the same two files; five workers editing them is five merge arguments,
# and the whole point of landing the vocabulary before the wave started was
# that nobody has to.
src/lib/authz/permissions.ts                  coordinator          write
src/lib/authz/roles.ts                        coordinator          write
src/lib/authz/roles.test.ts                   coordinator          write
src/components/nav/**                         coordinator          write
src/lib/demo/dataset.ts                       coordinator          write
src/lib/demo/types.ts                         coordinator          write
src/lib/demo/flag.ts                          coordinator          write
src/lib/contracts/**                          coordinator          write
src/lib/booking/types.ts                      coordinator          write
src/lib/plans/**                              coordinator          write
package.json                                  coordinator          write
next.config.ts                                coordinator          write
tsconfig.json                                 coordinator          write
eslint.config.mjs                             coordinator          write
.gitignore                                    coordinator          write
.env.example                                  coordinator          write
scripts/**                                    coordinator          write
project-memory/**                             coordinator          write
docs/**                                       coordinator          write

# ── Accepting an invitation. Claimed by name, above both owners below. ────
#
# The acceptance path crosses two territories that belong to different owners:
# it needs a migration (`authz`) and it needs the invitation domain
# (`domain-writes`). Neither of those workers is running, and splitting one act
# across two claims is how the SQL and the code that calls it end up disagreeing
# about what a used token means. So the four files are claimed here, by name,
# and the broader rows below keep everything else they had.
supabase/migrations/0027_invitation_acceptance.sql  coordinator    write
src/lib/invitations/acceptance.ts             coordinator          write
src/lib/invitations/acceptance.test.ts        coordinator          write
# The barrel, claimed for one reason: its header says acceptance "is not
# written yet". That sentence is now false, and a false comment at the top of
# the module people read first is worse than no comment.
src/lib/invitations/index.ts                  coordinator          write
src/app/invite/**                             coordinator          write
# The creating half, claimed for the same reason: the screen that mints a
# token and the screen that redeems one are one conversation, and the second
# is worthless without the first. `domain-writes` is not running.
src/app/(app)/team/invite/**                  coordinator          write
src/components/management/invite-member-form.tsx  coordinator      write

# ── Wave: preparation · laundry · inventory forecast · payment policy ─────
#
# Four capabilities that share one calculation. The register is written so
# that the *shared* pieces — the frozen contracts, the permission catalogue,
# the entitlements, the menu — are already landed and belong to the
# coordinator, and each worker below owns a disjoint set of new files plus one
# migration nobody else may touch.
#
# Migrations are claimed by number rather than by directory, because
# `supabase/migrations/**` belongs to `authz` and one act should not be split
# across two owners. Nobody applies their own migration; they are handed to
# the coordinator, who applies and verifies against the live catalogue.
supabase/migrations/0028_booking_party.sql          coordinator      write
supabase/migrations/0029_laundry.sql                laundry          write
supabase/migrations/0030_inventory_forecast.sql     inventory        write
supabase/migrations/0031_payment_collection.sql     payment-policy   write

# The laundry domain: requirements from the canonical preparation output,
# orders, providers, turnaround arithmetic, the forward demand curve.
# The adapter the module never had. `npm run reality` found it: five tables
# in 0029, rows in the demo dataset, ports declared — and nothing implementing
# them against Postgres, so the screens work in the demo and would find
# nothing in production.
# ── Runtime wave ──────────────────────────────────────────────────────────
# Autopilot's five stages are built and tested and NOTHING RUNS THEM.
# createCommandRegistry is exported and never called; no composition root
# builds the handler map with a request-scoped Db; the detectors have no
# fact source. Until this lands, everything in src/lib/autopilot is an
# engine nobody starts. This is the highest-value work outstanding.
#
# The deferred-release sweep is the other blocking gap: a message held by
# quiet hours is never released, in BOTH notification_deliveries and
# guest_messages — worse than the gate it passed through.

src/lib/autopilot/runtime/**                   autopilot-runtime write
src/lib/messaging/release.ts                   deferred-release write
src/lib/notifications/release.ts               deferred-release write

# ── P2 modules ────────────────────────────────────────────────────────────
# Named in the Market Leadership Program and absent from the product: no
# domain, no tables. Each agent builds domain-first and proposes its schema;
# the coordinator writes the migration.

src/lib/incidents/**                           incident-cases write
src/app/(app)/incidents/**                     incident-cases write
src/components/incidents/**                    incident-cases write

src/lib/owners/**                              owner-portal write
src/app/(app)/owners/**                        owner-portal write
src/components/owners/**                       owner-portal write

src/lib/guest-guide/**                         guest-guide write
src/app/(app)/settings/guest-guide/**          guest-guide write
src/components/guest-guide/**                  guest-guide write

src/lib/inventory/counts.ts                    stock-intelligence write
src/lib/inventory/loss.ts                      stock-intelligence write
src/app/(app)/inventory/counts/**              stock-intelligence write

# ── Domain commands wave ──────────────────────────────────────────────────
# Autopilot's decision layer is complete and 18 of its 33 actions resolve to
# no operation at all — the largest functional gap in the product. These
# agents build the missing commands in the modules that own the data.
#
# Each writes into a module a FINISHED prior-wave agent owns, so the claims
# below are placed ABOVE those rows and are scoped to new files plus the
# module's operations file. The register is most-specific-first, so this is
# a deliberate transfer for this wave and not a collision.
#
# access.issueCode and access.revokeCode are NOT here. The only access_code
# in the schema is a column on the other session's guest-journey table, and
# building them would mean writing into territory that is off limits. They
# stay recorded as unavailable.

src/lib/tasks/**                               tasks-domain     write
src/lib/messaging/**                           messaging-domain write
src/lib/inventory/commands.ts                  ops-inventory    write
src/lib/laundry/commands.ts                    ops-inventory    write
src/lib/store/commands.ts                      ops-store        write
src/lib/agents/commands.ts                     ops-store        write
src/lib/booking/holds-commands.ts              ops-store        write
src/lib/payments/requests.ts                   ops-store        write

src/lib/laundry/index.ts                      laundry-persistence  write
src/lib/laundry/repository.ts                 laundry-persistence  write
src/lib/laundry/repository.test.ts            laundry-persistence  write
src/lib/laundry/**                            laundry              write
src/lib/demo/dataset-laundry.ts               laundry              write

# The laundry screens — same owner as the domain, deliberately. A screen that
# imports a module a different worker has not written yet is the exact failure
# this register was created after.
# The screens, reclaimed: their reads name no organization_id and two of the
# loaders do not even take an actor, so they cannot. RLS would filter in
# production and the demo has no RLS at all.  is not running.
src/app/(app)/laundry/**                      laundry-persistence  write
src/components/laundry/**                     laundry              write

# The stock engine: circulation, reservation against future bookings, and the
# time-aware forecast that is the point of the whole module.
src/lib/inventory/**                          inventory            write
src/lib/persistence/inventory.ts              inventory            write

# The stock screens, including the existing ones, which are an upgrade rather
# than a rewrite. Same owner as the engine, for the reason above.
src/app/(app)/inventory/**                    inventory            write
src/components/operations/inventory-filter.tsx    inventory         write
src/components/operations/inventory-state.tsx     inventory         write

# What a guest must do before a booking is confirmed, and the screens that
# say so.
src/lib/payments/**                           payment-policy       write
src/app/(app)/settings/payments/**            payment-policy       write
src/components/payments/**                    payment-policy       write

# The chain from a real booking to a real plan: the intake fields the schema
# now stores, the delta when a booking changes, the cleaner's plan.
src/lib/persistence/booking.ts                preparation-chain    write
src/app/(app)/preparation/**                  preparation-chain    write
src/components/preparation/**                 preparation-chain    write
src/lib/preparation/**                        preparation-chain    write


# The commerce layer of the guest journey: catalogue, orders, and the guest
# store inside the booking portal. `product.*` and `order.*` grants already
# existed with no tables, no domain and no screen behind them — this is the
# thing they were declared for, so it is an ADD onto them rather than a
# parallel `store.*` vocabulary.
supabase/migrations/0032_store.sql            store                write
src/lib/store/**                              store                write
src/lib/demo/dataset-store.ts                 store                write
src/app/(app)/store/**                        store                write
src/components/store/**                       store                write

# The guest portal.
#
# The shell, the token and the session belong to the coordinator: a guest link
# is a capability URL, the second specification made the portal the home of the
# whole guest journey rather than of one module, and two workers building the
# same layout is the collision this register exists to prevent. The store owns
# its own section inside it and nothing else.
src/app/g/[token]/store/**                    store                write
src/lib/guest-portal/**                       coordinator          write
supabase/migrations/0033_guest_link.sql       coordinator          write
supabase/migrations/0034_guest_journey.sql    guest-journey        write
# The permission catalogue repair. Fourteen grants were added to the code and
# to nobody's database; four workers were writing policies against them. One
# mistake, one hand, one migration — splitting the repair across their four
# migrations would have made each carry a fragment of somebody else's
# oversight.
supabase/migrations/0035_permission_catalogue_wave_two.sql  coordinator  write
# Asked for by name after the cleaner could not read "two baby cots". Claimed
# because the worker that wrote it reported it falling through to `authz` for
# whoever ran the checker next.
supabase/migrations/0036_work_plan_facts.sql  preparation-chain    write
# The frame, and only the frame. Two workers build inside this portal and both
# need the same answer to "whose booking is this"; resolving the token twice is
# how one section eventually shows a guest somebody else's stay.
src/app/g/[token]/layout.tsx                  coordinator          write
src/lib/supabase/proxy.ts                     coordinator          write
src/app/g/**                                  guest-journey        write
# The second wave claims six files by name, above the broad rule below: the
# six modules already there are finished and belong to guest-journey, and
# these are new files beside them rather than edits to them.
src/lib/guest-journey/settings.ts             journey-settings     write
src/lib/guest-journey/settings.test.ts        journey-settings     write
src/lib/guest-journey/presets.ts              journey-settings     write
src/lib/guest-journey/presets.test.ts         journey-settings     write
src/lib/guest-journey/stay.ts                 guest-stay           write
src/lib/guest-journey/stay.test.ts            guest-stay           write
src/lib/guest-journey/post-stay.ts            guest-stay           write
src/lib/guest-journey/post-stay.test.ts       guest-stay           write
src/lib/guest-journey/**                      guest-journey        write
src/components/guest/**                       guest-journey        write
# The demo's guest-journey functions. Its own file rather than a block inside
# `client.ts`, because each one mirrors a SECURITY DEFINER function in 0034 and
# getting a refusal's order subtly wrong produces a demo that teaches the wrong
# behaviour. That is knowledge, not typing, and it belongs with whoever wrote
# the migration.
src/lib/demo/functions-guest.ts               guest-journey        write

# ── The guest journey, second wave ───────────────────────────────────────
#
# `guest_journey_settings` and `guest_journey_content` exist in 0034 and have
# no screen at all — the whole guest portal is driven by rows nobody can
# create through the product. Two workers, split so neither touches the six
# finished modules under `src/lib/guest-journey/`.
src/app/(app)/settings/guest-journey/**       journey-settings     write
src/components/journey-settings/**            journey-settings     write

src/components/guest-stay/**                  guest-stay           write
# ── Wave: the four capabilities the status picture named as absent ────────
#
# Each is new territory. None overlaps the other Claude session's claims —
# `supabase/tests/**`, `src/lib/guest-journey/**`,
# `src/app/(app)/settings/guest-journey/**`, `src/components/guest-stay/**`
# and `src/components/journey-settings/**` are theirs and appear nowhere here.
# The messaging channel between the two sessions is closed, so the register is
# the only coordination left and it must be read as binding rather than as
# advice.
supabase/migrations/0041_platform_admin.sql    platform-admin   write
# Autopilot's platform console. Listed BEFORE the platform-admin catch-alls
# because ownership is most-specific-first and these would otherwise never
# match — which the checker said, on its first run, before anything was built.
src/app/(platform)/platform/autopilot/**       autopilot-platform write
src/lib/platform/autopilot.ts                  autopilot-platform write

src/app/(platform)/**                          platform-admin   write
src/lib/platform/**                            platform-admin   write
src/components/platform/**                     platform-admin   write

supabase/migrations/0042_website_studio.sql    website-studio   write
src/app/(app)/website/**                       website-studio   write
src/app/s/**                                   website-studio   write
src/lib/website/**                             website-studio   write
src/components/website/**                      website-studio   write

supabase/migrations/0043_notifications.sql     notifications    write
src/lib/notifications/**                       notifications    write
src/app/(app)/settings/notifications/**        notifications    write
src/components/notifications/**                notifications    write

# ── Market parity wave (P1) ───────────────────────────────────────────────
# Certification found these three areas have a screen and NO domain and NO
# tables. The screens are honest views over canonical tables — /channels
# reports bookings by source — but they are not the capability. Each agent
# builds domain-pure first (engines, types, pure functions, tests) and
# proposes its schema; the coordinator writes and applies the migration,
# because agents do not write migrations.

src/lib/channels/**                            channels-parity  write
src/app/(app)/channels/**                      channels-parity  write
src/components/channels/**                     channels-parity  write

src/lib/migration/**                           migration-factory write
src/app/(app)/migration/**                     migration-factory write
src/components/migration/**                    migration-factory write

src/lib/fiscal/**                              israel-compliance write
src/lib/guest-book/**                          israel-compliance write
src/app/(app)/settings/fiscal/**               israel-compliance write
src/app/(app)/guest-book/**                    israel-compliance write
src/components/fiscal/**                       israel-compliance write

# ── Autopilot wave ────────────────────────────────────────────────────────
# The shared contract — states, events, grants, the action catalogue, the
# stage types and 0046 — is the coordinator's and is already written. Six
# agents build on top of it and none of them may edit it: a stage that widens
# its own contract is a stage the other five stop compiling against.
#
# The territories are disjoint by construction. Each agent owns one directory
# and writes nowhere else, so "did somebody overwrite my work" is answerable
# by `npm run ownership -- --agent <name>` rather than by reading a diff.

src/lib/autopilot/actions.ts                   coordinator      write
src/lib/autopilot/types.ts                     coordinator      write
src/lib/autopilot/index.ts                     coordinator      write
supabase/migrations/0046_autopilot.sql         coordinator      write

src/lib/autopilot/policy/**                    autopilot-core   write
src/lib/autopilot/signals/**                   autopilot-signals write
src/lib/autopilot/decide/**                    autopilot-decide write
src/lib/autopilot/execute/**                   autopilot-execute write
src/lib/autopilot/learning/**                  autopilot-learning write
src/app/(app)/autopilot/**                     autopilot-screens write
src/components/autopilot/**                    autopilot-screens write

src/app/(app)/insights/**                      insights         write
src/lib/insights/**                            insights         write
src/components/insights/**                     insights         write

# ── The authorization floor. Read by everyone, written by one. ────────────
src/lib/authz/**                              authz                write
src/lib/agents/**                             authz                write
src/lib/actor/**                              authz                write
src/lib/persistence/actor.ts                  authz                write
src/lib/persistence/agents.ts                 authz                write
supabase/migrations/**                        authz                write
# The SQL proofs, claimed with the migrations. isolation.sql proves 0001-0005
# and eleven migrations have landed since, so roughly forty tables carry RLS
# that nothing has ever proven isolates. Same territory as the schema itself.
supabase/tests/**                             db-proofs            write

# ── The write paths behind screens that already ship. ─────────────────────
#
# Three forms exist and cannot honestly submit: guest creation writes with no
# audit event and no idempotency key, and property creation and the team
# invitation have no domain operation at all, so their submits are disabled
# on screen. Closing that means new domain modules plus the three action files
# that call them, which is why those three files are claimed here and out of
# their screen group's hands for the duration.
src/lib/guests/**                             domain-writes        write
src/lib/properties/**                         domain-writes        write
src/lib/invitations/**                        domain-writes        write
src/lib/service/**                            domain-writes        write
src/app/(app)/guests/_lib/actions.ts          domain-writes        write
src/app/(app)/properties/**                   domain-writes        write
# team/invite moved to coordinator for this wave — see the invitation block
# above. Both halves of an invitation are one act and now have one writer.

# ── The one block with no domain at all, not merely no screen. ─────────────
# website and insights moved to website-studio / insights for this wave — see
# the block above. `ai-website` built automations and templates; those stay.
src/app/(app)/automations/**                  ai-website           write
src/app/(app)/templates/**                    ai-website           write
src/lib/automation/**                         ai-website           write

# ── The preparation chain: intake, policy, plan. ──────────────────────────
#
# The preparation engine is built and thorough — sleeping allocation, quantity
# rules driven by policy rather than by constants, the delta when a booking
# grows, a cleaner's view, an optional inventory layer. What is missing is at
# both ends: the booking form collects one guest count where the engine wants
# adults, children, infants, an event type and the extra beds, and the property
# configuration that decides every quantity has no screen anywhere.
src/app/(app)/bookings/**                     booking-intake       write
src/components/booking/**                     booking-intake       write
src/lib/booking/**                            booking-intake       write

# preparation moved to preparation-chain for this wave — see the block at
# the top. The policy screen it built is kept, not rewritten.
src/lib/persistence/preparation.ts            preparation-chain    write

# ── The home screen, rebuilt role by role. ────────────────────────────────
src/app/(app)/dashboard/**                    dashboard            write
src/components/dashboard/**                   dashboard            write

# ── End-to-end verification. Writes its own suite and nothing else. ───────
e2e/**                                        qa                   write
playwright.config.ts                          qa                   write

# ── Screen groups. Each owns its routes, its components, its demo data. ───
src/app/(app)/guests/**                       guests               write
src/components/guests/**                      guests               write
# dataset-bookings claimed for this wave: 0028 added five columns to
# `bookings`, and a seeded row without them makes every preparation plan page
# fail for seeded stays while working for one created through the form — the
# worst shape a fixture gap can take.
src/lib/demo/dataset-bookings.ts              coordinator          write

src/app/(app)/tasks/**                        operations           write
src/app/(app)/maintenance/**                  operations           write
# /incidents moved to incident-cases for this wave. What operations built
# there is a screen with no tables behind it — it queries nothing — and the
# damage-and-deposit case model is a new capability on the same route.
# inventory moved to inventory         for this wave — see the block above.
src/components/operations/**                  operations           write
src/lib/demo/dataset-operations.ts            operations           write

src/app/(app)/finance/**                      finance              write
src/components/finance/**                     finance              write
src/lib/finance/**                            finance              write
src/lib/persistence/finance.ts                finance              write
src/lib/demo/dataset-finance.ts               finance              write

src/app/(app)/units/**                        management           write
src/app/(app)/team/**                         management           write
src/app/(app)/roles/**                        management           write
src/app/(app)/integrations/**                 management           write
src/app/(app)/audit/**                        management           write
# properties moved to domain-writes for this wave — see the block above.
src/components/management/**                  management           write
src/lib/demo/dataset-inventory.ts             management           write

src/app/(app)/agents/**                       distribution         write
src/app/(app)/agencies/**                     distribution         write
src/app/(app)/quotes/**                       distribution         write
src/app/(app)/promotions/**                   distribution         write
# /channels moved to channels-parity for this wave. What distribution built
# there is a report of bookings BY SOURCE and is being kept; the channel
# manager — connectors, mapping, sync, reconciliation — is a new capability
# on the same route. Same precedent as website and insights above.
src/components/distribution/**                distribution         write
src/lib/demo/dataset-agents.ts                distribution         write

src/app/(app)/action-center/**                shell                write
src/app/(app)/activity/**                     shell                write
src/app/(app)/inbox/**                        shell                write
src/app/(app)/leads/**                        shell                write
src/app/(app)/settings/**                     shell                write
src/components/shell-screens/**               shell                write
src/lib/demo/dataset-support.ts               shell                write

src/app/(app)/reports/**                      reporting            write
src/components/reports/**                     reporting            write
src/lib/metrics/**                            reporting            write
src/lib/persistence/metrics.ts                reporting            write
# Everything preparation moved to preparation-config — see the block above.

# ── Everything else under the app shell and the persistence layer. ────────
src/app/(app)/_lib/**                          coordinator          write
src/app/(app)/layout.tsx                       coordinator          write
# dashboard moved to its own owner — see the block above.
src/app/(app)/onboarding/**                    coordinator          write
# bookings moved to booking-intake — see the block above.
src/app/(app)/calendar/**                      coordinator          write
src/app/(auth)/**                              coordinator          write
src/components/onboarding/**                   coordinator          write
src/components/demo/**                         coordinator          write
src/components/ui/**                           coordinator          write
src/components/states/**                       coordinator          write
src/lib/demo/**                                coordinator          write
src/lib/supabase/**                            coordinator          write
src/lib/persistence/**                         coordinator          write
src/lib/**                                     coordinator          write
src/**                                         coordinator          write

# Everything else under supabase/ that is not a migration or a proof. Listed
# last so it cannot shadow the two authz claims above, and listed at all
# because the checker found supabase/README.md unowned the first time it ran,
# which is precisely the gap it was written to find.
supabase/**                                    coordinator          write
```

<!-- OWNERSHIP:END -->

The last rows are catch-alls, most specific first — a file under
`src/lib/demo/dataset-finance.ts` matches the finance row, not the
`src/lib/demo/**` row below it. They exist so that "no owner" means a file
outside `src/` entirely, which is a louder signal than a hundred routine
matches.

## Running it

```
npm run ownership              # is the register self-consistent, and who owns what changed
npm run ownership -- --agent finance
```

The second form is the one that matters during a fan-out: it lists the changed
files that do **not** belong to that agent, which is the question worth asking
before anything is committed.
