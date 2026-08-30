/**
 * The one guarantee the switcher owes the production build: with the flag
 * off, it is not there.
 *
 * Not "hidden", not "empty" — absent. A control that reaches the markup and is
 * merely invisible is a control somebody finds with a devtools inspector, and
 * what it switches is which person you are signed in as. So the assertion is
 * on the returned tree rather than on a CSS class: `DemoSwitcher()` resolves
 * to `null`, and `renderToStaticMarkup` of that is the empty string.
 *
 * The second half is the pair to it. A server action is a public endpoint
 * addressable by its id, so "the component did not render the form" is not on
 * its own a reason the endpoint is safe. Both actions therefore check the flag
 * themselves, and both are called here with the flag off to prove they return
 * before touching a cookie — which is also why this test can call them at all:
 * `cookies()` outside a request would throw, and the fact that it does not is
 * the evidence.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import { DemoSwitcher } from './demo-switcher'
import { switchDemoPersonaAction, switchDemoPlanAction } from './actions'

const FLAG = 'NEXT_PUBLIC_ESTIA_DEMO'

afterEach(() => {
  delete process.env[FLAG]
})

describe('with the demo flag off', () => {
  it('renders nothing at all', async () => {
    delete process.env[FLAG]

    const tree = await DemoSwitcher()
    expect(tree).toBeNull()
    expect(renderToStaticMarkup(createElement('div', null, tree))).toBe(
      '<div></div>',
    )
  })

  it('renders nothing for a value that merely looks enabled', async () => {
    // `0`, `false` and `true` are all truthy strings. Only `1` is the demo.
    for (const value of ['0', 'false', 'true', '']) {
      process.env[FLAG] = value
      expect(await DemoSwitcher()).toBeNull()
    }
  })

  it('refuses to write the persona cookie', async () => {
    delete process.env[FLAG]

    const form = new FormData()
    form.set('persona', 'owner')

    // No request scope here, so `cookies()` would throw. Returning quietly is
    // the proof that it was never reached.
    await expect(switchDemoPersonaAction(form)).resolves.toBeUndefined()
  })

  it('refuses to write the plan cookie', async () => {
    delete process.env[FLAG]

    const form = new FormData()
    form.set('plan', 'basic')

    await expect(switchDemoPlanAction(form)).resolves.toBeUndefined()
  })
})

describe('with the demo flag on', () => {
  it('still refuses an empty selection rather than writing a blank cookie', async () => {
    process.env[FLAG] = '1'

    // Reached the flag check and passed it; stopped on the missing field,
    // before `cookies()`. A blank cookie would resolve to the default persona
    // and look like the switch silently doing nothing.
    await expect(
      switchDemoPersonaAction(new FormData()),
    ).resolves.toBeUndefined()
    await expect(switchDemoPlanAction(new FormData())).resolves.toBeUndefined()
  })
})
