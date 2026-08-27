/**
 * EXECUTION CONTEXT — SERVER ONLY, AND PRIVILEGED.
 *
 * ############################################################################
 * # THIS CLIENT BYPASSES ROW LEVEL SECURITY COMPLETELY.                      #
 * #                                                                          #
 * # It authenticates with the service role key, which Postgres treats as a   #
 * # superuser for the application schema. Every policy in                    #
 * # supabase/migrations/0004_rls.sql — including the tenant isolation rule   #
 * # `organization_id IN (SELECT public.my_organizations())` — is skipped.    #
 * # A single query written here can read or write EVERY organization's data. #
 * #                                                                          #
 * # It must ONLY ever be called from server code: a Server Action, a Route   #
 * # Handler, or a background job. Importing this module from a client        #
 * # component, or from any module reachable from one, is a security          #
 * # incident, not a bug. `serviceRoleKey()` throws in the browser and this    #
 * # module throws again on top of it, but neither guard is the real defence  #
 * # — reviewing every import of this file is.                                #
 * ############################################################################
 *
 * When to use it
 *   Only where the request has no user to act as, or where the operation is
 *   legitimately cross-tenant and the caller has already been authorised by
 *   `can()` from `src/lib/authz`. Examples: accepting an invitation before a
 *   membership exists, a webhook from a payment provider, a scheduled job.
 *
 * When NOT to use it
 *   To "make a query work". A query that fails under RLS is usually telling
 *   the truth: this user may not read that row. Reach for `./server.ts` and
 *   fix the policy or the authorisation, not the privilege level.
 *
 * Authorisation is NOT part of this file. Deciding what a user may do is
 * `can(user, action, resource)` in `src/lib/authz/can.ts`. This module only
 * removes the database's own floor; the permission engine above it still
 * applies and still has to be called.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { env, serviceRoleKey } from '@/lib/env'

/**
 * No session, no cookies, no token refresh. An admin client has no user, so
 * persisting or refreshing a session would be meaningless — and `persistSession`
 * left on would try to write to storage that does not exist on the server.
 */
export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'The Supabase admin client bypasses row level security and must never ' +
        'be constructed in the browser.',
    )
  }

  return createSupabaseClient(env.supabaseUrl, serviceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
