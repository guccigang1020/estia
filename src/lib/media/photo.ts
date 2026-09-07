/**
 * A photograph the customer supplies, and where it is allowed to go.
 *
 * PURE. Nothing here uploads, reads a file or touches a client — which is what
 * lets every refusal below be tested against a handmade value rather than a
 * real image and a real bucket.
 *
 * ══ THE PATH IS THE TENANT BOUNDARY ═════════════════════════════════════════
 *
 * Supabase Storage has no per-row organization column. `0076` therefore makes
 * the OBJECT NAME the boundary and every policy reads the first segment of it:
 *
 *     {organizationId}/{propertyId}/{uuid}.{ext}
 *
 * So `objectPath` is not a formatting helper — it is the thing the database
 * authorizes against, and it is the only function in the product allowed to
 * build one. A second place composing that string is a second place that can
 * get the first segment wrong.
 *
 * ══ THE EXTENSION COMES FROM THE CONTENT TYPE, NEVER THE FILENAME ═══════════
 *
 * A filename is supplied by whoever is uploading. `villa.jpg` can hold
 * anything, and `villa.php.jpg` is the shape of the oldest trick there is.
 * The type is read from the file's own declared content type, checked against
 * the allowlist, and the extension is then DERIVED from it. The original name
 * is never used to build a path — only, optionally, kept as a label.
 *
 * ══ THE LIMITS ARE STATED TWICE, ON PURPOSE ═════════════════════════════════
 *
 * The bucket in `0076` enforces the same size and the same MIME list. That is
 * not duplication to be tidied away: the checks here exist so a person gets a
 * sentence in Hebrew before a 40 MB upload crawls up a rural connection and
 * fails at the far end. The bucket's copy is the one that actually holds, and
 * if the two ever disagree the bucket wins — which is the right way round.
 */

/** Kept in step with `allowed_mime_types` on the bucket in 0076. */
export const ALLOWED_PHOTO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const

export type PhotoType = (typeof ALLOWED_PHOTO_TYPES)[number]

/**
 * 8 MB, matching `file_size_limit` on the bucket.
 *
 * Not a storage cost decision. It is roughly where a modern telephone
 * photograph sits, and comfortably under a camera original — the number is
 * chosen so an ordinary picture of a villa always passes and a raw export
 * never silently does.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024

/** Derived from the content type, never parsed out of a filename. */
const EXTENSION: Readonly<Record<PhotoType, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
})

export type PhotoProblem =
  | { readonly kind: 'type'; readonly given: string }
  | { readonly kind: 'too_large'; readonly bytes: number }
  | { readonly kind: 'empty' }

export function isPhotoType(value: string): value is PhotoType {
  return (ALLOWED_PHOTO_TYPES as readonly string[]).includes(value)
}

/**
 * Everything wrong with this file, in the order a person would meet it.
 *
 * All problems rather than the first: somebody who picked a 30 MB TIFF has two
 * things to fix and should be told both at once instead of discovering the
 * second after correcting the first.
 */
export function checkPhoto(file: {
  type: string
  size: number
}): readonly PhotoProblem[] {
  const problems: PhotoProblem[] = []

  if (!isPhotoType(file.type)) {
    problems.push({ kind: 'type', given: file.type })
  }
  if (file.size <= 0) {
    problems.push({ kind: 'empty' })
  } else if (file.size > MAX_PHOTO_BYTES) {
    problems.push({ kind: 'too_large', bytes: file.size })
  }

  return problems
}

/** A uuid-shaped string. The path is an authorization surface, so both ids
 *  are checked here rather than trusted from a caller. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidPhotoTarget extends Error {}

/**
 * The object name a photograph is stored under.
 *
 * `{organizationId}/{propertyId}/{uuid}.{ext}` — and it throws rather than
 * returning something almost right, because a malformed first segment does
 * not fail loudly at the database: `storage_object_organization` returns null
 * for it, null matches no organization, and the upload is simply refused with
 * a permission error nobody can read. Failing here says what is wrong.
 *
 * `unique` is injected rather than generated inside, so a test can state the
 * whole expected string instead of matching a pattern.
 */
export function objectPath(args: {
  organizationId: string
  propertyId: string
  type: PhotoType
  unique: string
}): string {
  if (!UUID.test(args.organizationId)) {
    throw new InvalidPhotoTarget(
      `organizationId is not a uuid: ${args.organizationId}`,
    )
  }
  if (!UUID.test(args.propertyId)) {
    throw new InvalidPhotoTarget(`propertyId is not a uuid: ${args.propertyId}`)
  }
  if (!isPhotoType(args.type)) {
    throw new InvalidPhotoTarget(`not an allowed image type: ${args.type}`)
  }
  if (args.unique.includes('/') || args.unique.trim() === '') {
    throw new InvalidPhotoTarget('the unique segment must be one path segment')
  }

  return `${args.organizationId}/${args.propertyId}/${args.unique}.${
    EXTENSION[args.type]
  }`
}

/** Megabytes, for a sentence a person reads. One decimal, never more. */
export function megabytes(bytes: number): string {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()
}

/** The Hebrew for each refusal. Says what to do, not what is wrong. */
export function photoProblemMessage(problem: PhotoProblem): string {
  if (problem.kind === 'type') {
    return 'אפשר להעלות תמונה בלבד — JPG, PNG, WebP או AVIF.'
  }
  if (problem.kind === 'too_large') {
    return `התמונה שוקלת ${megabytes(problem.bytes)}MB והמגבלה היא ${megabytes(
      MAX_PHOTO_BYTES,
    )}MB. הקטינו אותה ונסו שוב.`
  }
  return 'הקובץ ריק.'
}
