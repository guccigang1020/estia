import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * Where the build output goes, so that two Next servers can run out of one
   * checkout.
   *
   * Next refuses a second `next dev` in a directory that already has one,
   * because both processes would be writing the same `.next` — and the failure
   * is not a clean refusal so much as two servers quietly corrupting each
   * other's output. That is ordinarily the right protection. It is the wrong
   * one for the demo, whose entire purpose is to be opened *beside* the real
   * dev server: the same screen as an owner and as a cleaner, side by side,
   * without stopping the work being compared.
   *
   * So `npm run demo` sets `NEXT_DIST_DIR=.next-demo` and the two no longer
   * share a directory. Unset — which is every ordinary `dev`, `build` and
   * `start` — this is exactly the default it has always been.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
}

export default nextConfig
