'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Putting the customer's own photograph of
 * their property where the product can show it.
 *
 * ══ THE UPLOAD RUNS AS THE SIGNED-IN PERSON, AND THAT IS THE WHOLE DESIGN ═══
 *
 * `createClient()`, never `createAdminClient()`. Supabase Storage has no
 * per-row organization column, so `0076` makes the object NAME the tenant
 * boundary and every policy on `storage.objects` reads its first segment.
 * Those policies only run if the upload arrives as `authenticated` — a
 * service-role client would bypass every one of them, and the isolation this
 * feature rests on would exist only in this file.
 *
 * So the path is built by `objectPath` (the one function allowed to compose
 * one) and the database decides whether this person may write there. Two
 * floors, as everywhere else: `assertCan` here, row level security underneath.
 *
 * ══ VALIDATION HERE IS A COURTESY; THE BUCKET IS THE RULE ═══════════════════
 *
 * `checkPhoto` refuses a 40 MB camera original before it crawls up a rural
 * connection, which is worth doing. But the bucket in `0076` carries the same
 * size limit and the same MIME allowlist, and if the two ever disagree the
 * bucket wins. That is the right way round and is stated in `photo.ts` too.
 *
 * ══ THE OLD PHOTOGRAPH IS REMOVED AFTER THE NEW ONE IS SAFE ════════════════
 *
 * Never before. A delete-then-upload that fails in the middle leaves a
 * property with no picture and no way back; an upload-then-delete that fails
 * in the middle leaves one orphaned object in a bucket, which costs pennies
 * and nothing else. When the removal fails the action still SUCCEEDS — the
 * customer's new photograph is up, and telling them their upload failed
 * because a cleanup did would be a lie about the thing they care about.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  checkPhoto,
  isPhotoType,
  objectPath,
  photoProblemMessage,
} from '@/lib/media/photo'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'

const BUCKET = 'property-photos'
const SCREEN = '/properties'

export type PhotoResult =
  { ok: true; url: string } | { ok: false; error: SafeErrorBody }

function refuse(
  code: string,
  message: string,
  correlationId: string,
): PhotoResult {
  return {
    ok: false,
    error: {
      code,
      message,
      dataMessage: 'התמונה לא נשמרה.',
      retryMessage: 'אפשר לנסות שוב עם קובץ אחר.',
      dataOutcome: 'not_saved',
      retryable: false,
      correlationId,
    },
  }
}

/**
 * Store a photograph and make it the property's cover.
 *
 * The file arrives as `FormData` rather than as a base64 string: a data URL of
 * an 8 MB photograph is an 11 MB string through a server action payload, and
 * the browser already knows how to stream a file.
 */
export async function uploadPropertyPhotoAction(
  form: FormData,
): Promise<PhotoResult> {
  const correlationId = crypto.randomUUID()

  const context = await shellContext()
  if (!context || context.status !== 'ready') {
    return refuse(
      'unauthenticated',
      'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
      correlationId,
    )
  }

  const propertyId = String(form.get('propertyId') ?? '')
  const file = form.get('photo')

  if (!(file instanceof File)) {
    return refuse('no_file', 'לא נבחר קובץ.', correlationId)
  }

  const problems = checkPhoto({ type: file.type, size: file.size })
  if (problems.length > 0 || !isPhotoType(file.type)) {
    const first = problems[0]
    return refuse(
      'photo_rejected',
      first
        ? photoProblemMessage(first)
        : 'אפשר להעלות תמונה בלבד — JPG, PNG, WebP או AVIF.',
      correlationId,
    )
  }

  try {
    // The service floor. Row level security refuses underneath regardless, and
    // the storage policy asks for the same grant on the same organization.
    assertCan(context.actor, 'property.update', {
      organizationId: context.actor.organizationId,
      propertyId,
    })

    const db = await createClient()

    const path = objectPath({
      organizationId: context.actor.organizationId,
      propertyId,
      type: file.type,
      unique: crypto.randomUUID(),
    })

    const stored = await db.storage.from(BUCKET).upload(path, file, {
      contentType: file.type,
      // A fresh uuid every time, so nothing is ever overwritten in place and a
      // cached copy of the previous picture cannot be served for the new one.
      upsert: false,
      cacheControl: '31536000',
    })

    if (stored.error) throw stored.error

    const {
      data: { publicUrl },
    } = db.storage.from(BUCKET).getPublicUrl(path)

    // Read the old one BEFORE overwriting the column, so there is something to
    // clean up afterwards. `maybeSingle` because a property the caller cannot
    // see returns no row rather than an error, and the update below then
    // affects nothing — which the check after it turns into a real refusal.
    const previous = await db
      .from('properties')
      .select('cover_image_url')
      .eq('organization_id', context.actor.organizationId)
      .eq('id', propertyId)
      .maybeSingle()

    const written = await db
      .from('properties')
      .update({
        cover_image_url: publicUrl,
        updated_by: context.actor.userId,
      })
      .eq('organization_id', context.actor.organizationId)
      .eq('id', propertyId)
      .select('id')

    if (written.error) throw written.error

    // An UPDATE matching zero rows SUCCEEDS. Without this the screen would
    // report saving a photograph it never attached to anything — the same
    // failure 0070 found on `agencies_update`.
    if (!written.data || written.data.length === 0) {
      await db.storage.from(BUCKET).remove([path])
      return refuse(
        'property_not_found',
        'הנכס לא נמצא, או שאין לך הרשאה לערוך אותו. התמונה לא נשמרה.',
        correlationId,
      )
    }

    // Only now, and a failure here is not the caller's problem.
    const old = (previous.data as { cover_image_url?: string } | null)
      ?.cover_image_url
    if (old && old.includes(`/${BUCKET}/`)) {
      const oldPath = old.split(`/${BUCKET}/`)[1]
      if (oldPath) {
        const removed = await db.storage.from(BUCKET).remove([oldPath])
        if (removed.error) {
          // Worth a line in the log and nothing more: one orphaned object.
          console.error('[property-photo] the previous picture stayed', {
            correlationId,
          })
        }
      }
    }

    revalidatePath(SCREEN)
    revalidatePath('/dashboard')
    revalidatePath('/listings')

    return { ok: true, url: publicUrl }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/** Take the cover photograph off a property. The object goes with it. */
export async function removePropertyPhotoAction(input: {
  propertyId: string
}): Promise<PhotoResult> {
  const correlationId = crypto.randomUUID()

  const context = await shellContext()
  if (!context || context.status !== 'ready') {
    return refuse(
      'unauthenticated',
      'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
      correlationId,
    )
  }

  try {
    assertCan(context.actor, 'property.update', {
      organizationId: context.actor.organizationId,
      propertyId: input.propertyId,
    })

    const db = await createClient()

    const current = await db
      .from('properties')
      .select('cover_image_url')
      .eq('organization_id', context.actor.organizationId)
      .eq('id', input.propertyId)
      .maybeSingle()

    const written = await db
      .from('properties')
      .update({ cover_image_url: null, updated_by: context.actor.userId })
      .eq('organization_id', context.actor.organizationId)
      .eq('id', input.propertyId)
      .select('id')

    if (written.error) throw written.error
    if (!written.data || written.data.length === 0) {
      return refuse(
        'property_not_found',
        'הנכס לא נמצא, או שאין לך הרשאה לערוך אותו.',
        correlationId,
      )
    }

    const url = (current.data as { cover_image_url?: string } | null)
      ?.cover_image_url
    if (url && url.includes(`/${BUCKET}/`)) {
      const path = url.split(`/${BUCKET}/`)[1]
      if (path) await db.storage.from(BUCKET).remove([path])
    }

    revalidatePath(SCREEN)
    revalidatePath('/dashboard')
    revalidatePath('/listings')

    return { ok: true, url: '' }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
