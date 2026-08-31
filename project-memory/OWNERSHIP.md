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
src/app/(app)/team/invite/**                  domain-writes        write

# ── The one block with no domain at all, not merely no screen. ─────────────
src/app/(app)/website/**                      ai-website           write
src/app/(app)/automations/**                  ai-website           write
src/app/(app)/templates/**                    ai-website           write
src/app/(app)/insights/**                     ai-website           write
src/components/website/**                     ai-website           write
src/lib/website/**                            ai-website           write
src/lib/automation/**                         ai-website           write

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
src/app/(app)/inventory/**                    operations           write
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
src/app/(app)/preparation/**                  reporting            write
src/components/reports/**                     reporting            write
src/components/preparation/**                 reporting            write
src/lib/metrics/**                            reporting            write
src/lib/preparation/**                        reporting            write
src/lib/persistence/metrics.ts                reporting            write
src/lib/persistence/preparation.ts            reporting            write

# ── Everything else under the app shell and the persistence layer. ────────
src/app/(app)/_lib/**                          coordinator          write
src/app/(app)/layout.tsx                       coordinator          write
src/app/(app)/dashboard/**                     coordinator          write
src/app/(app)/onboarding/**                    coordinator          write
src/app/(app)/bookings/**                      coordinator          write
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
