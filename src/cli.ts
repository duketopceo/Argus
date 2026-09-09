#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  bindSession,
  renderTestFile,
  takeTests,
  td,
  test as registerTest,
  TdSession,
} from './api.js'
import { Config, loadConfig, unknownProviderSlugs } from './config.js'
import { BrowserDriver } from './driver/browser.js'
import { TargetProcess } from './driver/target.js'
import { Engine, VisionClient } from './engine/loop.js'
import { Actions } from './engine/actions.js'
import { JunitCase, writeJunitXml } from './report/junit.js'
import { buildRunReport, TestReport, writeRunReport } from './report/run.js'
import { flowPath, loadFlow } from './cache/store.js'
import { OpenRouterClient } from './vision/openrouter.js'
import { Ledger } from './vision/ledger.js'

export interface CliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  out?: (line: string) => void
  err?: (line: string) => void
  /** Inject a vision client (tests stub this; default builds OpenRouterClient). */
  createClient?: (config: Config) => VisionClient
  /** Inject a driver factory (tests may stub browser launch). */
  launchDriver?: () => Promise<BrowserDriver>
}

interface Ctx {
  cwd: string
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = `vision-e2e — vision-model E2E testing harness (BYOK via OPENROUTER_API_KEY)

Usage:
  vision-e2e record "<flow description>" --url <target> [--name <flow>] [--tests-dir <dir>]
  vision-e2e run [pattern] [--url <target>] [--dir <testsDir>] [--report-dir <dir>]
  vision-e2e cache list [--dir <cacheDir>]
  vision-e2e cache prune [name|--all] [--dir <cacheDir>]
  vision-e2e --help

Config: vision-e2e.config.ts or vision-e2e.config.json in the working directory
(model, escalation_model, provider rules, budgetUsd, target, cacheDir,
testsDir, reportDir, secrets).`

const RECORD_USAGE = `Usage: vision-e2e record "<flow description>" --url <target> [options]

Options:
  --url <url>        Target URL (falls back to config.target.url)
  --name <name>      Flow name for the cache + generated test file
  --tests-dir <dir>  Where to write the generated test file (default: config testsDir or ./tests)
  -h, --help         Show this help`

const RUN_USAGE = `Usage: vision-e2e run [pattern] [options]

Discovers *.test.{ts,mts,mjs,js} under the tests dir, executes each against the
target, and writes JUnit XML + a JSON run report.

Options:
  [pattern]          Only run test files whose path contains this substring
  --url <url>        Target URL (falls back to config.target.url)
  --dir <dir>        Tests directory (default: config testsDir or ./tests)
  --report-dir <dir> Report output dir (default: config reportDir or ./vision-e2e-report)
  --cache-dir <dir>  Fingerprint cache dir (default: config cacheDir)
  -h, --help         Show this help`

const CACHE_USAGE = `Usage: vision-e2e cache <list|prune> [options]

  cache list                 List cached flows (name + step count)
  cache prune [name|--all]   Delete one flow cache, or all with --all

Options:
  --dir <dir>   Cache directory (default: config cacheDir or ./.vision-e2e-cache)
  -h, --help    Show this help`

const TEST_FILE_RE = /\.test\.(ts|mts|mjs|js)$/

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const ctx: Ctx = {
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    out: deps.out ?? ((line) => console.log(line)),
    err: deps.err ?? ((line) => console.error(line)),
  }

  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    ctx.out(USAGE)
    return 0
  }

  switch (cmd) {
    case 'record':
      return cmdRecord(rest, ctx, deps)
    case 'run':
      return cmdRun(rest, ctx, deps)
    case 'cache':
      return cmdCache(rest, ctx)
    default:
      ctx.err(`unknown command: ${cmd}`)
      ctx.out(USAGE)
      return 2
  }
}

function createClient(deps: CliDeps, config: Config, ctx: Ctx): VisionClient {
  if (deps.createClient) return deps.createClient(config)
  const apiKey = ctx.env.OPENROUTER_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      'OPENROUTER_API_KEY is not set — every vision call is billed through this key (BYOK)',
    )
  }
  return new OpenRouterClient({ apiKey })
}

async function launchDriver(deps: CliDeps): Promise<BrowserDriver> {
  if (deps.launchDriver) return deps.launchDriver()
  return BrowserDriver.launch()
}

function warnUnknownProviders(config: Config, ctx: Ctx): void {
  for (const slug of unknownProviderSlugs(config.provider)) {
    ctx.err(`warning: unknown provider slug "${slug}" in provider rules — passing through anyway`)
  }
}

async function startTarget(config: Config): Promise<TargetProcess | undefined> {
  const target = config.target
  if (target === undefined || target.command === '') return undefined
  return TargetProcess.start(target)
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug === '' ? 'flow' : slug
}

async function cmdRecord(args: string[], ctx: Ctx, deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      url: { type: 'string' },
      name: { type: 'string' },
      'tests-dir': { type: 'string' },
    },
  })
  if (values.help) {
    ctx.out(RECORD_USAGE)
    return 0
  }

  const description = positionals.join(' ').trim()
  if (description === '') {
    ctx.err('record requires a flow description: vision-e2e record "<flow>" --url <target>')
    return 2
  }

  const config = await loadConfig(ctx.cwd)
  warnUnknownProviders(config, ctx)

  const url = values.url ?? config.target?.url
  if (url === undefined) {
    ctx.err('no target URL: pass --url or set config.target.url')
    return 2
  }
  const flowName = values.name ?? slugify(description)

  let target: TargetProcess | undefined
  let driver: BrowserDriver | undefined
  try {
    target = await startTarget(config)
    driver = await launchDriver(deps)
    const setupTmp = await mkdtemp(join(tmpdir(), 'vision-e2e-setup-'))
    await applyPageSetup(config, driver, ctx, setupTmp)
    const client = createClient(deps, config, ctx)
    const ledger = new Ledger(config.budgetUsd)
    const actions = new Actions(driver)
    const engine = new Engine({ driver, actions, client, ledger, config })

    ledger.startSandbox()
    await driver.goto(target?.url ?? url)
    const result = await engine.record(description, actions, { flowName })
    ledger.stopSandbox()

    const state = ledger.state
    ctx.out(
      `record ${result.ok ? 'succeeded' : 'FAILED'}: ${result.steps.length} steps, ` +
        `${result.visionCalls} vision calls, $${state.visionCostUsd.toFixed(6)} vision spend`,
    )
    if (result.reason !== undefined) ctx.err(`reason: ${result.reason}`)
    if (state.budgetExceeded) ctx.err('budget cap was hit during record')

    const testsDir = resolve(ctx.cwd, values['tests-dir'] ?? config.testsDir ?? 'tests')
    await mkdir(testsDir, { recursive: true })
    const cacheDir = config.cacheDir ?? join(ctx.cwd, '.vision-e2e-cache')
    const flow = await loadFlow(cacheDir, flowName)
    const testFile = join(testsDir, `${flowName}.test.ts`)
    await writeFile(testFile, renderTestFile(flowName, flow?.steps ?? []), 'utf8')
    ctx.out(`wrote test file: ${testFile}`)
    if (config.cacheDir !== undefined) ctx.out(`wrote cache: ${flowPath(cacheDir, flowName)}`)

    return result.ok ? 0 : 1
  } catch (e) {
    ctx.err(`record failed: ${(e as Error).message}`)
    return 1
  } finally {
    await driver?.close()
    await target?.stop()
  }
}

async function discoverTestFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await discoverTestFiles(path)))
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      found.push(path)
    }
  }
  return found.sort()
}

async function importModule(file: string, tmpDir: string): Promise<Record<string, unknown>> {
  let target = file
  if (extname(file) === '.ts' || extname(file) === '.mts') {
    let transpile: (source: string) => string
    try {
      const ts = await import('typescript')
      transpile = (source) =>
        ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText
    } catch {
      throw new Error(
        `cannot execute TypeScript module ${file}: the "typescript" package is not ` +
          'available. Install it or ship precompiled .mjs modules.',
      )
    }
    const source = await readFile(file, 'utf8')
    await mkdir(tmpDir, { recursive: true })
    target = join(tmpDir, `${basename(file)}.${process.pid}.mjs`)
    await writeFile(target, transpile(source), 'utf8')
  }
  return (await import(`${pathToFileURL(target).href}?t=${Date.now()}`)) as Record<string, unknown>
}

async function importTestFile(file: string, tmpDir: string): Promise<void> {
  await importModule(file, tmpDir)
}

type PageSetupFn = (page: unknown) => void | Promise<void>

/**
 * Optional `config.pageSetup` module: default-exported function invoked with
 * the Playwright Page after launch, before navigation — the seam for
 * page.route mocks and pre-navigation seeding.
 */
async function applyPageSetup(
  config: Config,
  driver: BrowserDriver,
  ctx: Ctx,
  tmpDir: string,
): Promise<void> {
  if (config.pageSetup === undefined || config.pageSetup === '') return
  const file = resolve(ctx.cwd, config.pageSetup)
  const mod = await importModule(file, tmpDir)
  const setup = mod.default
  if (typeof setup !== 'function') {
    throw new Error(`pageSetup module ${file} must default-export a function`)
  }
  await (setup as PageSetupFn)(driver.rawPage)
}

interface GlobalPatch {
  key: string
  previous: unknown
}

function patchGlobals(): GlobalPatch[] {
  const g = globalThis as Record<string, unknown>
  const patches: GlobalPatch[] = [
    { key: 'td', previous: g.td },
    { key: 'test', previous: g.test },
  ]
  g.td = td
  g.test = registerTest
  return patches
}

function restoreGlobals(patches: GlobalPatch[]): void {
  const g = globalThis as Record<string, unknown>
  for (const { key, previous } of patches) {
    if (previous === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete g[key]
    } else {
      g[key] = previous
    }
  }
}

async function cmdRun(args: string[], ctx: Ctx, deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      url: { type: 'string' },
      dir: { type: 'string' },
      'report-dir': { type: 'string' },
      'cache-dir': { type: 'string' },
    },
  })
  if (values.help) {
    ctx.out(RUN_USAGE)
    return 0
  }

  const config = await loadConfig(ctx.cwd)
  warnUnknownProviders(config, ctx)
  if (values['cache-dir'] !== undefined) config.cacheDir = values['cache-dir']

  const url = values.url ?? config.target?.url
  if (url === undefined) {
    ctx.err('no target URL: pass --url or set config.target.url')
    return 2
  }

  const pattern = positionals[0]
  const testsDir = resolve(ctx.cwd, values.dir ?? config.testsDir ?? 'tests')
  const reportDir = resolve(
    ctx.cwd,
    values['report-dir'] ?? config.reportDir ?? 'vision-e2e-report',
  )
  const allFiles = await discoverTestFiles(testsDir)
  const files = pattern === undefined ? allFiles : allFiles.filter((f) => f.includes(pattern))

  if (files.length === 0) {
    ctx.out(`no test files found under ${testsDir}`)
  }

  const startedAt = new Date()
  const runStart = Date.now()
  const reports: TestReport[] = []
  const junitCases: JunitCase[] = []
  const tmpDir = join(reportDir, '.transpiled')

  let target: TargetProcess | undefined
  const patches = patchGlobals()
  try {
    target = await startTarget(config)
    const client = createClient(deps, config, ctx)

    for (const file of files) {
      const fileName = basename(file)
      const fileSlug = fileName.replace(TEST_FILE_RE, '')
      let driver: BrowserDriver | undefined
      try {
        driver = await launchDriver(deps)
        await applyPageSetup(config, driver, ctx, tmpDir)

        // A file-level session so test files that call `td` at module top
        // level (no test() wrapper) still execute as a single named test.
        const fileSession = await TdSession.create({
          driver,
          client,
          config,
          flowName: fileSlug,
          env: ctx.env,
        })
        bindSession(fileSession)
        await driver.goto(target?.url ?? url)
        const importStart = Date.now()
        let importError: Error | undefined
        try {
          await importTestFile(file, tmpDir)
        } catch (e) {
          importError = e as Error
        }

        const registered = takeTests()
        if (registered.length === 0) {
          const state = fileSession.ledgerState
          const ok = importError === undefined && !fileSession.failed
          const failureMessage =
            importError?.message ?? (fileSession.failed ? fileSession.failureReason : undefined)
          reports.push({
            name: fileSlug,
            file,
            ok,
            durationMs: Date.now() - importStart,
            failureMessage,
            steps: fileSession.steps,
            asserts: fileSession.asserts,
            healEvents: fileSession.healEvents,
            visionCalls: fileSession.visionCalls,
            visionCostUsd: state.visionCostUsd,
            sandboxSeconds: state.sandboxSeconds,
            budgetExceeded: state.budgetExceeded,
            videoPath: undefined,
          })
          await fileSession.save()
        } else {
          for (const registeredTest of registered) {
            const session = await TdSession.create({
              driver,
              client,
              config,
              flowName: `${fileSlug}__${slugify(registeredTest.name)}`,
              env: ctx.env,
            })
            bindSession(session)
            session.ledger.startSandbox()
            const testStart = Date.now()
            let error: Error | undefined
            try {
              await driver.goto(target?.url ?? url)
              await registeredTest.fn(session.td)
            } catch (e) {
              error = e as Error
            } finally {
              session.ledger.stopSandbox()
            }
            const state = session.ledgerState
            const ok = error === undefined && !session.failed
            const failureMessage =
              error?.message ?? (session.failed ? session.failureReason : undefined)
            reports.push({
              name: registeredTest.name,
              file,
              ok,
              durationMs: Date.now() - testStart,
              failureMessage,
              steps: session.steps,
              asserts: session.asserts,
              healEvents: session.healEvents,
              visionCalls: session.visionCalls,
              visionCostUsd: state.visionCostUsd,
              sandboxSeconds: state.sandboxSeconds,
              budgetExceeded: state.budgetExceeded,
              videoPath: undefined,
            })
            await session.save()
            ctx.out(`${ok ? 'PASS' : 'FAIL'} ${registeredTest.name} (${fileName})`)
          }
        }

        const video = await driver.close()
        driver = undefined
        if (video !== undefined) {
          for (const report of reports) {
            if (report.file === file && report.videoPath === undefined) {
              report.videoPath = video
            }
          }
        }
      } catch (e) {
        reports.push({
          name: fileSlug,
          file,
          ok: false,
          durationMs: 0,
          failureMessage: (e as Error).message,
          steps: [],
          asserts: [],
          healEvents: [],
          visionCalls: 0,
          visionCostUsd: 0,
          sandboxSeconds: 0,
          budgetExceeded: false,
          videoPath: undefined,
        })
      } finally {
        await driver?.close()
        bindSession(undefined)
      }
    }
  } catch (e) {
    ctx.err(`run failed: ${(e as Error).message}`)
    return 1
  } finally {
    restoreGlobals(patches)
    await target?.stop()
  }

  for (const report of reports) {
    junitCases.push({
      name: report.name,
      className: basename(report.file),
      durationMs: report.durationMs,
      ok: report.ok,
      failureMessage: report.failureMessage,
    })
  }
  const report = buildRunReport(reports, startedAt, Date.now() - runStart)
  await mkdir(reportDir, { recursive: true })
  await writeJunitXml(join(reportDir, 'junit.xml'), 'vision-e2e', junitCases)
  await writeRunReport(join(reportDir, 'run.json'), report)
  ctx.out(
    `run complete: ${report.totals.passed}/${report.totals.tests} passed, ` +
      `${report.totals.visionCalls} vision calls, ` +
      `$${report.totals.visionCostUsd.toFixed(6)} vision spend — reports in ${reportDir}`,
  )
  return report.ok ? 0 : 1
}

async function cmdCache(args: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      dir: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  })
  const [sub, ...restPositionals] = positionals
  if (values.help || sub === undefined || (sub !== 'list' && sub !== 'prune')) {
    ctx.out(CACHE_USAGE)
    return sub === undefined || values.help ? 0 : 2
  }

  const config = await loadConfig(ctx.cwd)
  const cacheDir = resolve(
    ctx.cwd,
    values.dir ?? config.cacheDir ?? join(ctx.cwd, '.vision-e2e-cache'),
  )

  if (sub === 'list') {
    let names: string[] = []
    try {
      names = (await readdir(cacheDir)).filter((f) => f.endsWith('.json')).sort()
    } catch {
      names = []
    }
    if (names.length === 0) {
      ctx.out(`cache empty (${cacheDir})`)
      return 0
    }
    for (const name of names) {
      const flowName = name.replace(/\.json$/, '')
      const flow = await loadFlow(cacheDir, flowName)
      ctx.out(`${flowName}: ${flow?.steps.length ?? 0} steps`)
    }
    return 0
  }

  // prune
  if (!values.all && restPositionals.length === 0) {
    ctx.err('cache prune requires a flow name or --all')
    return 2
  }
  let names: string[] = []
  try {
    names = (await readdir(cacheDir)).filter((f) => f.endsWith('.json'))
  } catch {
    names = []
  }
  const targets = values.all ? names : restPositionals.map((n) => `${n}.json`)
  let removed = 0
  for (const name of targets) {
    try {
      await rm(join(cacheDir, name))
      removed++
    } catch {
      ctx.err(`warning: could not remove ${name}`)
    }
  }
  ctx.out(`pruned ${removed} cached flow(s) from ${cacheDir}`)
  return 0
}

const invokedAsScript = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    )
  } catch {
    return false
  }
})()

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`vision-e2e: ${(e as Error).message}`)
      process.exitCode = 1
    })
}
