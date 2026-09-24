import { defaultExec, type ExecFn } from '../detect.js'

/** Whether a report's source can be tied to the intended PR head. */
export type HeadBindingStatus = 'match' | 'mismatch' | 'unknown' | 'not_applicable'
export type HeadSource = 'github' | 'fixture' | 'local'

export interface HeadBinding {
  intendedSha: string | undefined
  checkoutSha: string | undefined
  status: HeadBindingStatus
  source: HeadSource
  detail: string
}

/** Read the checked-out commit without making git identity a hard dependency. */
export async function readCheckoutSha(cwd: string, exec: ExecFn = defaultExec): Promise<string | undefined> {
  const result = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], 10_000)
  if (result.code !== 0) return undefined
  const sha = result.stdout.trim()
  return sha === '' ? undefined : sha
}

/** Classify the relationship between API/fixture head identity and the checkout. */
export function classifyHeadBinding(
  intendedSha: string | undefined,
  checkoutSha: string | undefined,
  source: HeadSource,
): HeadBinding {
  if (source === 'fixture') {
    return {
      intendedSha,
      checkoutSha,
      status: 'not_applicable',
      source,
      detail: 'fixture diff is bound to its local fixture head',
    }
  }
  if (intendedSha === undefined || intendedSha === '') {
    return {
      intendedSha,
      checkoutSha,
      status: 'unknown',
      source,
      detail: 'PR head identity was unavailable',
    }
  }
  if (checkoutSha === undefined || checkoutSha === '') {
    return {
      intendedSha,
      checkoutSha,
      status: 'unknown',
      source,
      detail: 'checkout identity was unavailable',
    }
  }
  if (intendedSha === checkoutSha) {
    return {
      intendedSha,
      checkoutSha,
      status: 'match',
      source,
      detail: 'checkout matches the intended PR head',
    }
  }
  return {
    intendedSha,
    checkoutSha,
    status: 'mismatch',
    source,
    detail: `checkout ${checkoutSha} does not match intended PR head ${intendedSha}`,
  }
}
