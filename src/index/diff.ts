import { execFile } from 'node:child_process'

/**
 * Changed files vs a base ref (PR diff) or the working tree when no base is
 * given. Returns repo-relative paths. Any git failure resolves to an empty
 * set — diff detection is an optimization, never a gate.
 */
export async function diffChangedFiles(cwd: string, base?: string): Promise<string[]> {
  const args =
    base !== undefined && base !== ''
      ? ['diff', '--name-only', `${base}...HEAD`]
      : ['status', '--porcelain', '--untracked-files=all']
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd }, (err, stdout) => {
      if (err) {
        resolvePromise([])
        return
      }
      const lines = stdout
        .split('\n')
        .map((l) => (base !== undefined ? l.trim() : l.replace(/^..\s+/, '').trim()))
        .filter((l) => l !== '' && !l.startsWith('R ') && !l.includes(' -> '))
      resolvePromise(lines)
    })
  })
}
