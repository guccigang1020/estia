/**
 * What these tests are actually claiming.
 *
 * Not that acceptance works — that lives in `public.accept_invitation`, and a
 * fake client cannot prove a plpgsql function checks an expiry. What they
 * prove is the edge this file is responsible for, and each of those is a claim
 * somebody could get wrong in a refactor:
 *
 *   · the raw token never reaches the database, only its digest
 *   · every refusal the function can raise becomes a Hebrew sentence and a
 *     status, rather than a raw SQLSTATE on somebody's screen
 *   · a refusal the function raises that this file has not heard of still
 *     produces a real sentence, and is labelled as unrecognised rather than
 *     passing for a designed message
 *   · a malformed reply is reported as "we could not read the answer", not as
 *     a membership with empty ids
 */

import { describe, expect, it } from 'vitest'

import { AppError, BusinessRuleError, NotFoundError } from '../errors'
import { FakeSupabaseClient } from '../persistence/fake-client'

import { acceptInvitation, InvitationRefusedError } from './acceptance'
import { hashInvitationToken } from './token'

const TOKEN = 'wZ8k-3Qm_LrTn0aB1cD2eF3gH4iJ5kL6'

const ACCEPTED = {
  membershipId: '4b6f0d5e-1f3a-4c2d-8e9b-0a1b2c3d4e5f',
  organizationId: '9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
  organizationName: 'אחוזת רימונים',
  roleId: '11111111-2222-3333-4444-555555555555',
  created: true,
  replay: false,
}

function client(response: {
  data?: unknown
  error?: {
    code: string
    message: string
    hint?: string | null
    details?: string | null
  } | null
}) {
  return new FakeSupabaseClient({
    responses: { 'rpc:accept_invitation': response },
  })
}

describe('acceptInvitation', () => {
  it('sends the digest and never the token', async () => {
    const fake = client({ data: ACCEPTED })

    await acceptInvitation(fake.asDb(), TOKEN)

    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0].table).toBe('rpc:accept_invitation')

    const payload = fake.queries[0].payload as { p_token_hash: string }
    expect(payload.p_token_hash).toBe(await hashInvitationToken(TOKEN))
    // A SHA-256 digest in hex, and demonstrably not the token itself. The
    // second assertion is the one that matters: it fails the moment somebody
    // "simplifies" this by passing the token straight through.
    expect(payload.p_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(fake.queries)).not.toContain(TOKEN)
  })

  it('trims a token pasted with surrounding whitespace', async () => {
    const fake = client({ data: ACCEPTED })

    await acceptInvitation(fake.asDb(), `  ${TOKEN}\n`)

    const payload = fake.queries[0].payload as { p_token_hash: string }
    expect(payload.p_token_hash).toBe(await hashInvitationToken(TOKEN))
  })

  it('returns the membership the function reports', async () => {
    const fake = client({ data: ACCEPTED })

    await expect(acceptInvitation(fake.asDb(), TOKEN)).resolves.toEqual({
      membershipId: ACCEPTED.membershipId,
      organizationId: ACCEPTED.organizationId,
      organizationName: ACCEPTED.organizationName,
      roleId: ACCEPTED.roleId,
      created: true,
      replay: false,
    })
  })

  it('carries the replay flag through, so a refresh is not an error', async () => {
    const fake = client({
      data: { ...ACCEPTED, created: false, replay: true },
    })

    const result = await acceptInvitation(fake.asDb(), TOKEN)
    expect(result.replay).toBe(true)
    expect(result.created).toBe(false)
  })

  it('refuses an empty token without calling the database', async () => {
    const fake = client({ data: ACCEPTED })

    await expect(acceptInvitation(fake.asDb(), '   ')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    expect(fake.queries).toHaveLength(0)
  })

  // Every code `accept_invitation` raises. If the function gains one and this
  // list does not, the "unrecognised" test below is what catches it — but the
  // person still gets a sentence, which is the point.
  const REFUSALS: readonly [string, number][] = [
    ['not_authenticated', 401],
    ['invitation_not_found', 404],
    ['invitation_already_used', 409],
    ['invitation_revoked', 409],
    ['invitation_expired', 410],
    ['invitation_email_mismatch', 403],
    ['already_member', 409],
    ['organization_missing', 404],
    ['role_missing', 409],
  ]

  it.each(REFUSALS)('turns %s into a Hebrew refusal', async (code, status) => {
    const fake = client({
      error: { code: 'P0001', message: code, hint: 'לא רלוונטי' },
    })

    const failure = await acceptInvitation(fake.asDb(), TOKEN).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(InvitationRefusedError)
    expect(failure).toBeInstanceOf(BusinessRuleError)

    const refusal = failure as InvitationRefusedError
    expect(refusal.code).toBe(code)
    expect(refusal.status).toBe(status)
    expect(refusal.dataOutcome).toBe('not_saved')
    expect(refusal.retryable).toBe(false)
    // Hebrew, and this file's wording rather than the hint the database sent.
    expect(refusal.userMessage).toMatch(/[֐-׿]/)
    expect(refusal.userMessage).not.toBe('לא רלוונטי')
  })

  it('uses the database hint for a refusal it has not heard of', async () => {
    const fake = client({
      error: {
        code: 'P0001',
        message: 'seat_limit_reached',
        hint: 'הארגון הגיע למספר המשתמשים שבחבילה.',
      },
    })

    const failure = (await acceptInvitation(fake.asDb(), TOKEN).catch(
      (error: unknown) => error,
    )) as InvitationRefusedError

    expect(failure).toBeInstanceOf(InvitationRefusedError)
    expect(failure.userMessage).toBe('הארגון הגיע למספר המשתמשים שבחבילה.')
    // Labelled, so it reads as a gap between the SQL and this file rather than
    // as a message somebody wrote on purpose.
    expect(failure.code).toBe('invitation_refused_seat_limit_reached')
  })

  it('rethrows a database failure that is not a refusal at all', async () => {
    const fake = client({
      error: { code: '57014', message: 'canceling statement due to timeout' },
    })

    const failure = await acceptInvitation(fake.asDb(), TOKEN).catch(
      (error: unknown) => error,
    )

    expect(failure).not.toBeInstanceOf(InvitationRefusedError)
    expect((failure as { code: string }).code).toBe('57014')
  })

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['an object with no membership', { organizationId: 'x' }],
    ['an object with no organization', { membershipId: 'x' }],
  ])('reports an unreadable reply when it is %s', async (_label, data) => {
    const fake = client({ data })

    const failure = await acceptInvitation(fake.asDb(), TOKEN).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AppError)
    const error = failure as AppError
    expect(error.code).toBe('invitation_acceptance_unreadable')
    // "Unknown", not "not saved". The function may well have committed — this
    // is the reply being unreadable, not the write having failed, and telling
    // somebody their membership was not created when it was is the worse lie.
    expect(error.dataOutcome).toBe('unknown')
    expect(error.retryable).toBe(true)
  })
})
