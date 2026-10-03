#!/usr/bin/env node
// npm run demo:record — record the README casts in assets/demo/*.tape.
//
//   npm run build && npm run demo:record            # every tape
//   npm run demo:record -- run-cache-hit            # one tape
//   npm run demo:record -- --seed                   # re-seed the flow cache first
//
// Each tape runs in a staged, clean environment (plan R27): HOME is a fresh
// temp dir, PATH holds only node, the argus-reviewer shim and /usr/bin, git
// has a demo identity, and no OPENROUTER_API_KEY exists (R32: the script
// refuses to start if one is set). The `run` and `verify` casts replay
// fixtures/demo-cache/checkout.flow.json, a cache seeded with zero model
// calls by scripts/demo-seed.mjs, so they cost $0.
//
// Output: docs/assets/demo/<tape>.gif (committed, embedded in the README)
// and argus-reviewer-report/demo/<tape>.mp4 plus review stills (gitignored;
// the MP4 is what goes to a GitHub video upload). Requires vhs, ttyd,
// ffmpeg, gifski and woff2_decompress on PATH, and a Playwright chromium download.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { keyRefusal } from './qa/capture-web.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const DEMO = join(ROOT, 'assets/demo')
const PROJECT = join(ROOT, 'fixtures/demo-cache/project')
const FLOW = join(ROOT, 'fixtures/demo-cache/checkout.flow.json')
const GIF_DIR = join(ROOT, 'docs/assets/demo')
const MP4_DIR = join(ROOT, 'argus-reviewer-report/demo')
const CLI = join(ROOT, 'dist/cli.js')
const GIF_FPS = 12
/** README budget per GIF (plan U17: 3 MB or less). */
export const GIF_BUDGET_BYTES = 3 * 1024 * 1024

function fail(msg) {
  console.error(`demo:record: ${msg}`)
  process.exit(1)
}

/** Fixed identity and dates so the staged commit sha is the same every run. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Argus Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Argus Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

/** Build the clean environment and the two demo projects under one temp dir. */
export function stage() {
  const work = mkdtempSync(join(tmpdir(), 'argus-demo-'))
  const home = join(work, 'home')
  const bin = join(work, 'bin')
  mkdirSync(join(home, '.cache'), { recursive: true })
  mkdirSync(bin)

  // Browsers and fonts come from outside the clean HOME by link, not by env,
  // so nothing in the recorded shell points back at the real home.
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright')
  if (!existsSync(browsers)) fail(`no Playwright browsers at ${browsers}; run npx playwright install chromium`)
  symlinkSync(browsers, join(home, '.cache/ms-playwright'))
  // Chromium's bundled FreeType cannot read WOFF2, so the brand subsets are
  // decompressed to TTF for the terminal renderer.
  const fonts = join(home, '.local/share/fonts')
  mkdirSync(fonts, { recursive: true })
  for (const name of ['martian-mono-var', 'argus-glyphs']) {
    copyFileSync(join(ROOT, 'assets/brand/fonts', `${name}.woff2`), join(fonts, `${name}.woff2`))
    const r = spawnSync('woff2_decompress', [join(fonts, `${name}.woff2`)], { encoding: 'utf8' })
    if (r.status !== 0) fail(`woff2_decompress failed for ${name} (${r.error?.message ?? r.stderr}); install woff2`)
    rmSync(join(fonts, `${name}.woff2`))
  }
  const fontconf = join(home, '.config/fontconfig')
  mkdirSync(fontconf, { recursive: true })
  writeFileSync(
    join(fontconf, 'fonts.conf'),
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${fonts}</dir>
  <match target="scan">
    <test name="family"><string>Martian Mono VF sWd Rg</string></test>
    <edit name="family" mode="assign" binding="same"><string>Martian Mono</string></edit>
  </match>
</fontconfig>
`,
  )

  symlinkSync(process.execPath, join(bin, 'node'))
  writeFileSync(join(bin, 'argus-reviewer'), `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 })

  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    ...GIT_ENV,
  }
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, stdio: 'ignore' })

  const shop = join(work, 'shop')
  cpSync(PROJECT, shop, { recursive: true })
  writeFileSync(join(shop, '.gitignore'), 'argus-reviewer-report/\n.argus-reviewer-cache/\n')
  git(shop, ['init', '-q', '-b', 'main'])
  git(shop, ['add', '.'])
  git(shop, ['commit', '-q', '-m', 'demo shop'])
  if (existsSync(FLOW)) {
    mkdirSync(join(shop, '.argus-reviewer-cache'))
    copyFileSync(FLOW, join(shop, '.argus-reviewer-cache/checkout.json'))
  }

  const fresh = join(work, 'my-app')
  mkdirSync(fresh)
  writeFileSync(join(fresh, 'package.json'), '{ "name": "my-app", "private": true }\n')
  git(fresh, ['init', '-q', '-b', 'main'])
  git(fresh, ['add', '.'])
  git(fresh, ['commit', '-q', '-m', 'my app'])

  copyFileSync(join(DEMO, 'shell-profile.sh'), join(work, 'shell-profile.sh'))
  return { work, env, shop }
}

function seed({ env, shop }) {
  rmSync(join(shop, '.argus-reviewer-cache'), { recursive: true, force: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/demo-seed.mjs'), CLI, 'checkout', '#place-order'], {
    cwd: shop,
    env,
    encoding: 'utf8',
  })
  if (r.status !== 0) fail(`seeding failed:\n${r.stderr}`)
  copyFileSync(join(shop, r.stdout.trim()), FLOW)
  // The seed's report and the staged cache are throwaway; the cast starts
  // from the committed flow file only.
  rmSync(join(shop, 'argus-reviewer-report'), { recursive: true, force: true })
  console.log(`seeded ${FLOW.slice(ROOT.length)} (0 model calls, replay verified as a cache hit)`)
}

function record(tape, { work, env }) {
  rmSync(join(work, 'out'), { recursive: true, force: true })
  const r = spawnSync('vhs', [join(DEMO, `${tape}.tape`)], { cwd: work, env, encoding: 'utf8' })
  if (r.error) fail(`could not start vhs (${r.error.message}); install vhs, ttyd and ffmpeg`)
  if (r.status !== 0) fail(`vhs ${tape} exited ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`)
  const mp4 = join(work, 'out', `${tape}.mp4`)
  mkdirSync(MP4_DIR, { recursive: true })
  copyFileSync(mp4, join(MP4_DIR, `${tape}.mp4`))

  const frames = join(MP4_DIR, `${tape}-frames`)
  rmSync(frames, { recursive: true, force: true })
  mkdirSync(frames)
  execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', `fps=${GIF_FPS}`, join(frames, '%04d.png')])
  const pngs = readdirSync(frames).filter((f) => f.endsWith('.png')).sort().map((f) => join(frames, f))
  mkdirSync(GIF_DIR, { recursive: true })
  const gif = join(GIF_DIR, `${tape}.gif`)
  execFileSync('gifski', ['--quiet', '--fps', String(GIF_FPS), '--quality', '80', '-o', gif, ...pngs])
  const size = statSync(gif).size
  const secs = pngs.length / GIF_FPS
  console.log(`${tape}: ${secs.toFixed(1)}s, gif ${(size / 1024).toFixed(0)} KB, mp4 ${(statSync(mp4).size / 1024).toFixed(0)} KB`)
  if (size > GIF_BUDGET_BYTES) fail(`${basename(gif)} is ${size} bytes, over the ${GIF_BUDGET_BYTES} byte README budget`)
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const refusal = keyRefusal()
  if (refusal) {
    console.error(refusal.replace('QA captures', 'Demo casts'))
    process.exit(3)
  }
  if (!existsSync(CLI)) fail('dist/cli.js is missing; run npm run build first')
  const args = process.argv.slice(2)
  const tapes = args.filter((a) => !a.startsWith('--'))
  const all = readdirSync(DEMO).filter((f) => f.endsWith('.tape')).map((f) => f.replace(/\.tape$/, '')).sort()
  for (const t of tapes) if (!all.includes(t)) fail(`no tape ${t}; have ${all.join(', ')}`)
  const staged = stage()
  try {
    if (args.includes('--seed')) seed(staged)
    if (!existsSync(FLOW)) fail('no seeded flow cache; run with --seed')
    for (const tape of tapes.length > 0 ? tapes : all) {
      // Each tape gets a fresh stage so one cast's files never show in another.
      rmSync(staged.work, { recursive: true, force: true })
      Object.assign(staged, stage())
      record(tape, staged)
    }
  } finally {
    rmSync(staged.work, { recursive: true, force: true })
  }
}
