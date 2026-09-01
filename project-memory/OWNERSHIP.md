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
src/lib/laundry/**                            laundry              write
src/lib/demo/dataset-laundry.ts               laundry              write

# The laundry screens — same owner as the domain, deliberately. A screen that
# imports a module a different worker has not written yet is the exact failure
# this register was created after.
src/app/(app)/laundry/**                      laundry              write
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
# The frame, and only the frame. Two workers build inside this portal and both
# need the same answer to "whose booking is this"; resolving the token twice is
# how one section eventually shows a guest somebody else's stay.
src/app/g/[token]/layout.tsx                  coordinator          write
src/lib/supabase/proxy.ts                     coordinator          write
src/app/g/**                                  guest-journey        write
# ── The authorization floor. Read by everyone, written by one. ────────────
src/lib/authz/**                              authz                write
src/lib/agents/**                             authz                write
src/lib/actor/**                              authz                write
src/lib/persistence/actor.ts                  authz                write
src/lib/persistence/agents.ts                 authz                write
supabase/migrations/**                        authz                write
supabase/tests/**                             authz                write

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
src/app/(app)/website/**                      ai-website           write
src/app/(app)/automations/**                  ai-website           write
src/app/(app)/templates/**                    ai-website           write
src/app/(app)/insights/**                     ai-website           write
src/components/website/**                     ai-website           write
src/lib/website/**                            ai-website           write
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
src/lib/demo/dataset-bookings.ts              guests               write

src/app/(app)/tasks/**                        operations           write
src/app/(app)/maintenance/**                  operations           write
src/app/(app)/incidents/**                    operations           write
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
src/app/(app)/channels/**                     distribution         write
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
