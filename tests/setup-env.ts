/**
 * Hermetic test environment.
 *
 * The CLI's checkout-trust gate (#58/#64) resolves trust from ambient CI
 * env (`GITHUB_EVENT_NAME`, …) and fails closed on unlisted events. When
 * the suite itself runs inside GitHub Actions (`push`/`pull_request`),
 * those variables leak into every spawned CLI subprocess and the gate
 * filters config to untrusted JSON-only — record/delegation/cache/hooks/
 * JUnit flows silently short-circuit even though the tests exercise the
 * documented *local* (trusted) semantics.
 *
 * Tests that need a CI context pass env explicitly (see trust.test.ts),
 * so stripping it here only removes accidental host leakage.
 */
import { beforeAll } from 'vitest'

const strip = (key: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete process.env[key]
}

const CI_ENV_KEYS = [
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_REPOSITORY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ARGUS_TRUSTED',
  'ARGUS_UNTRUSTED',
  'ARGUS_REVIEWER_TRACE',
] as const

beforeAll(() => {
  for (const key of CI_ENV_KEYS) strip(key)
})
