/**
 * The file storage port — declared, deliberately not implemented.
 *
 * ── Why there is no implementation in this file ───────────────────────────
 *
 * This codebase has no file storage layer. Nothing anywhere calls
 * `supabase.storage`, no bucket is created in any migration, and no other
 * module uploads or serves a byte. Building "just enough" of one here — a
 * bucket invented by this module, a naming scheme nobody else agreed to, an
 * access rule that only guest receipts obey — would put the product's first
 * storage decision inside its narrowest feature, and every later uploader
 * would either inherit it or contradict it.
 *
 * So the shape of the dependency is stated and the decision is escalated. The
 * table `payment_proofs` stores `storage_key` as an opaque string precisely so
 * that whatever answers this port can define what a key means without a
 * migration.
 *
 * ── What an implementation has to provide ─────────────────────────────────
 *
 *   · A **key**, unique within the organization, that this module records and
 *     never parses.
 *   · A way for a *guest* — no account, no session, holding only
 *     `bookings.guest_token` — to upload. That is the hard requirement, and it
 *     is why a plain authenticated bucket is not enough. A signed upload URL
 *     minted by the server after it has checked the token is the shape that
 *     fits; the token check already exists as `guest_collection_context()`.
 *   · A **short-lived** read URL for staff. A receipt carries a bank account
 *     number; a permanent public URL for one is a data leak with a long tail.
 *   · Deletion, for the day a guest asks to be forgotten.
 *
 * Until something implements it, `recordPaymentProof` still works: it is given
 * a key by its caller and stores the reference. What is missing is the piece
 * that produces the key, and the product refuses rather than pretends —
 * `NoProofStorageError` is what a route gets, with a Hebrew sentence that says
 * uploading is not available yet rather than a broken file input.
 */

import { AppError } from '../errors'

/** What the port hands back after taking the bytes. */
export interface StoredProof {
  /** Opaque to this module. Written to `payment_proofs.storage_key`. */
  key: string
  fileName: string
  contentType: string
  byteSize: number
  /** Hex sha-256, where the implementation computed one. */
  checksumSha256: string | null
}

export interface UploadTicket {
  /** Where the browser PUTs the bytes. Short-lived. */
  url: string
  /** The key the upload will land under, so the caller can record it. */
  key: string
  expiresAt: Date
}

export interface ProofStorage {
  /**
   * Mint a one-shot upload target for a guest holding `guestToken`.
   *
   * The token, not a session, is the authorization — see the header, and see
   * `0031_payment_collection.sql` §8 for the same argument made in SQL.
   */
  ticketForGuest(args: {
    guestToken: string
    fileName: string
    contentType: string
    byteSize: number
  }): Promise<UploadTicket>

  /** A short-lived read URL for a member of staff reviewing the receipt. */
  readUrl(key: string, ttlSeconds: number): Promise<string>

  remove(key: string): Promise<void>
}

/**
 * There is no storage wired, and the product says so.
 *
 * A 501 rather than a 500: nothing is broken, the capability does not exist
 * yet. `dataOutcome: 'not_saved'` because no proof row is written either —
 * a reference to bytes that were never stored is worse than no reference.
 */
export class NoProofStorageError extends AppError {
  constructor() {
    super({
      code: 'payments.no_proof_storage',
      status: 501,
      message:
        'No ProofStorage implementation is wired; see src/lib/payments/storage.ts',
      userMessage:
        'העלאת אסמכתאות אינה זמינה עדיין במערכת. שלח את האסמכתה ישירות לבית האירוח, והצוות ירשום את התשלום.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

/**
 * The honest default.
 *
 * Wired wherever a `ProofStorage` is required and none exists, so that the
 * absence surfaces as one named error at the one moment somebody tries to use
 * it — rather than as an `undefined` three frames further in.
 */
export const NO_PROOF_STORAGE: ProofStorage = {
  ticketForGuest() {
    return Promise.reject(new NoProofStorageError())
  },
  readUrl() {
    return Promise.reject(new NoProofStorageError())
  },
  remove() {
    return Promise.reject(new NoProofStorageError())
  },
}

/** True when the wiring is the placeholder above. Screens ask before offering. */
export function proofStorageAvailable(storage: ProofStorage | null): boolean {
  return storage !== null && storage !== NO_PROOF_STORAGE
}
