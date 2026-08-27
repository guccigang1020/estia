'use client'

import { SubmitButton } from './submit-button'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT wrapping a Server Action form.
 *
 * A `<form>` with a POST action, not a link. Sign-out changes server state, and
 * a GET that mutates is a CSRF hole waiting for an `<img src="/sign-out">` on
 * any page the user visits. Server Actions post with an origin check, which is
 * what makes this the safe shape.
 *
 * The action is passed in rather than imported, so this component carries no
 * dependency on the auth route group and can be dropped into the dashboard
 * shell as it is.
 */
export function SignOutButton({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action}>
      <SubmitButton label="התנתקות" pendingLabel="מתנתקים…" />
    </form>
  )
}
