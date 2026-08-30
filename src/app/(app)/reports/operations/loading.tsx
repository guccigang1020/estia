import ReportsLoading from '../loading'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * The operating report draws the same tiles in the same grid as the financial
 * one, so it waits behind the same placeholder. Re-declaring the markup here
 * would be a second copy to fall out of step with the tile it is standing in
 * for — and a skeleton that no longer matches its screen is worse than none.
 */
export default function OperatingReportLoading() {
  return <ReportsLoading />
}
