import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Changed files vs a base ref (PR diff) or the working tree when no base is
 * given. Returns repo-relative paths. Any git failure resolves to an empty
 * set — diff detection is an optimization, never a gate.
 */
const GIT_OPTS = { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 } as const

/** A git ref must look like a ref, not an option or arbitrary arg. */
function safeBaseRef(base: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._/~-]*$/.test(base) ? base : undefined
}

export async function diffChangedFiles(cwd: string, base?: string): Promise<string[]> {
  const safe = base !== undefined ? safeBaseRef(base) : undefined
  const useBase = safe !== undefined
  const args = useBase
    ? ['diff', '--name-only', `${safe}...HEAD`]
    : ['status', '--porcelain', '--untracked-files=all']
  const { stdout } = await execFileAsync('git', args, { cwd, ...GIT_OPTS }).catch(() => ({ stdout: '' }))
  return stdout
    .split('\n')
    .map((l) => (useBase ? l.trim() : l.replace(/^..\s+/, '').trim()))
    .filter((l) => l !== '' && !l.startsWith('R ') && !l.includes(' -> '))
}
