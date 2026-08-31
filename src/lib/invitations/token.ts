/**
 * The invitation token.
 *
 * An invitation is a capability URL: whoever holds the link is admitted to the
 * organization with the role the row names. That makes the token a credential
 * and every property below follows from that one sentence.
 *
 * **Minted with a cryptographically secure generator.** `crypto.getRandomValues`
 * and never `Math.random`, which is seeded, predictable, and has been the root
 * cause of guessable-token advisories for twenty years. Thirty-two bytes, so
 * guessing one is not a thing an attacker does.
 *
 * **Stored hashed, never in plain text.** `invitations.token_hash` is the only
 * column, and 0001 says why in its own comment: a leaked database backup must
 * not hand out organization access. The raw token exists in exactly two
 * places — the link that goes to the invitee, and the return value of
 * `mintInvitationToken` on the one request that created it. It is never
 * written down, never logged, and deliberately not part of any operation's
 * result, because an operation result is persisted into `idempotency_keys` and
 * that would put the credential back in the database by the side door.
 *
 * **SHA-256 and not a password hash.** Deliberate, and the reason is the
 * threat model rather than laziness: a password is low-entropy and chosen by a
 * person, so it needs a slow KDF to survive an offline dictionary attack. This
 * token is 256 bits from the system CSPRNG, and there is no dictionary. What
 * matters here is that the stored value is not usable as a credential and that
 * lookup is a single indexed equality — bcrypt would give the first and take
 * the second away.
 *
 * **Web Crypto, not `node:crypto`.** Nothing else in `src/lib` imports a Node
 * builtin, and this module has no reason to be the first: `crypto.subtle` is
 * present in Node, in the Edge runtime and in the test environment alike.
 */

/** Bytes of entropy in a token. 256 bits. */
const TOKEN_BYTES = 32

/**
 * How long an unaccepted invitation stays usable.
 *
 * A week, because that is roughly the span over which a person who was told
 * "I have invited you" actually gets round to it, and because
 * `invitations_expires_after_creation` requires *some* answer. An invitation
 * that never expires is a credential in somebody's mailbox forever.
 */
export const INVITATION_TTL_DAYS = 7

/** The longest expiry a caller may ask for. Beyond it, the link is a liability. */
export const INVITATION_MAX_TTL_DAYS = 30

/**
 * Base64url, from bytes, without padding.
 *
 * The token travels in a URL, so `+`, `/` and `=` are all wrong: the first two
 * are re-encoded by some mail clients and the third is stripped by others, and
 * either turns a valid invitation into "this link has expired".
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The hash that goes in the column.
 *
 * Exported because accepting an invitation is the other half of this: the
 * acceptance path hashes the token from the link and looks the row up by
 * `token_hash`. Both halves must use one function or the second will never
 * find what the first wrote.
 */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return toHex(digest)
}

export type MintedInvitationToken = {
  /** Shown once, in the link. Never stored, never logged. */
  token: string
  /** What `invitations.token_hash` receives. */
  tokenHash: string
}

export async function mintInvitationToken(): Promise<MintedInvitationToken> {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)

  const token = toBase64Url(bytes)
  return { token, tokenHash: await hashInvitationToken(token) }
}

/**
 * When an invitation minted `now` stops working.
 *
 * Computed from the injected clock rather than `new Date()`, so an operation's
 * output is deterministic and a test can assert the expiry rather than assume
 * it.
 */
export function invitationExpiry(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
}
