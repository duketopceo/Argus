// Materialize the two bake-off fixture repos (demo-pr + an Ocellus-diff subset)
// as throwaway git repos in a work dir OUTSIDE the Argus checkout.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SUBS = {
  __ARGUS_DEMO_DOC_KEY__: `AKIA${'IOSFODNN7EXAMPLE'}`,
  __ARGUS_DEMO_LIVE_KEY__: `sk_live_${'51Qfake00DEMO7xK2mNvT9rLp'}`,
}
// Modified (not new) src files of the Ocellus redesign diff, excluding the
// 1.4k-line cli.ts so each review stays bounded.
export const OCELLUS_FILES = [
  'src/report/comment.ts', 'src/executor/a0.ts', 'src/pipeline/verify.ts', 'src/config.ts',
  'src/engine/prompts.ts', 'src/detect.ts', 'src/driver/browser.ts', 'src/report/run.ts',
  'src/report/manifest.ts', 'src/evidence/ci.ts', 'src/vision/openrouter.ts', 'src/vision/decisions.ts',
  'src/driver/target.ts', 'src/review/secrets.ts', 'src/probe/queue.ts', 'src/pipeline/budget.ts', 'src/fsutil.ts',
]
const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=b@x', '-c', 'user.name=bakeoff', ...args], { stdio: ['ignore', 'pipe', 'inherit'] }).toString()

function copyTree(src, dst, substitute) {
  mkdirSync(dst, { recursive: true })
  for (const n of readdirSync(src)) {
    const s = join(src, n), d = join(dst, n)
    if (statSync(s).isDirectory()) copyTree(s, d, substitute)
    else {
      let c = readFileSync(s, 'utf8')
      if (substitute) for (const [k, v] of Object.entries(SUBS)) c = c.replaceAll(k, v)
      writeFileSync(d, c)
    }
  }
}
function commit(repo, msg) { git(repo, ['add', '-A']); git(repo, ['commit', '-m', msg]) }

export function materializeDemo(root, work) {
  const repo = join(work, 'demo-pr')
  rmSync(repo, { recursive: true, force: true })
  copyTree(join(root, 'fixtures/demo-pr/base'), repo, false)
  git(repo, ['init', '-b', 'pr']); commit(repo, 'base'); git(repo, ['branch', 'argus-fixture-base'])
  copyTree(join(root, 'fixtures/demo-pr/head'), repo, true); commit(repo, 'head')
  return repo
}
export function materializeOcellus(root, work, baseRef = '1dfd9b5~40', headRef = '1dfd9b5') {
  const repo = join(work, 'ocellus')
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'pr'])
  const put = (ref) => {
    for (const f of OCELLUS_FILES) {
      const body = execFileSync('git', ['-C', root, 'show', `${ref}:${f}`], { maxBuffer: 1 << 26 })
      mkdirSync(dirname(join(repo, f)), { recursive: true })
      writeFileSync(join(repo, f), body)
    }
  }
  put(baseRef); commit(repo, 'base'); git(repo, ['branch', 'argus-fixture-base'])
  put(headRef); commit(repo, 'head')
  return repo
}
