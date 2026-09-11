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
import { CallCost } from './vision/cost.js'
import { JsonSchema, Message, OpenRouterClient } from './vision/openrouter.js'
import { Ledger } from './vision/ledger.js'

export interface CliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  out?: (line: string) => void
  err?: (line: string) => void
  /** Inject a vision client (tests stub this; default builds OpenRouterClient). */
  createClient?: (config: Config) => VisionClient
  /** Inject a driver factory (tests may stub browser launch). */
  launchDriver?: (config: Config) => Promise<BrowserDriver>
}

interface Ctx {
  cwd: string
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = `argus-reviewer — vision-model E2E testing harness (BYOK via OPENROUTER_API_KEY)

Usage:
  argus-reviewer record "<flow description>" --url <target> [--name <flow>] [--tests-dir <dir>]
  argus-reviewer run [pattern] [--url <target>] [--dir <testsDir>] [--report-dir <dir>]
  argus-reviewer code-review [--report-dir <dir>]
  argus-reviewer cache list [--dir <cacheDir>]
  argus-reviewer cache prune [name|--all] [--dir <cacheDir>]
  argus-reviewer --help

Config: vision-e2e.config.ts or vision-e2e.config.json in the working directory
(model, escalation_model, provider rules, budgetUsd, target, cacheDir,
testsDir, reportDir, secrets).`

const RECORD_USAGE = `Usage: argus-reviewer record "<flow description>" --url <target> [options]

Options:
  --url <url>        Target URL (falls back to config.target.url)
  --name <name>      Flow name for the cache + generated test file
  --tests-dir <dir>  Where to write the generated test file (default: config testsDir or ./tests)
  -h, --help         Show this help`

const RUN_USAGE = `Usage: argus-reviewer run [pattern] [options]

Discovers *.test.{ts,mts,mjs,js} under the tests dir, executes each against the
target, and writes JUnit XML + a JSON run report.

Options:
  [pattern]          Only run test files whose path contains this substring
  --url <url>        Target URL (falls back to config.target.url)
  --dir <dir>        Tests directory (default: config testsDir or ./tests)
  --report-dir <dir> Report output dir (default: config reportDir or ./vision-e2e-report)
  --cache-dir <dir>  Fingerprint cache dir (default: config cacheDir)
  -h, --help         Show this help`

const CODE_REVIEW_USAGE = `Usage: argus-reviewer code-review [options]

Reviews the PR diff for the repo/PR referenced by ARGUS_REVIEWER_TRACE using the
configured code model. Writes code-review.json next to run.json.

Options:
  --report-dir <dir> Report output dir (default: config reportDir or ./vision-e2e-report)
  -h, --help         Show this help`

const CACHE_USAGE = `Usage: argus-reviewer cache <list|prune> [options]

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
    case 'code-review':
      return cmdCodeReview(rest, ctx, deps)
    case 'cache':
      return cmdCache(rest, ctx)
    default:
      ctx.err(`unknown command: ${cmd}`)
      ctx.out(USAGE)
      return 2
  }
}

function parseOpenRouterTrace(env: Ctx['env']): Record<string, string> | undefined {
  const raw = env.ARGUS_REVIEWER_TRACE
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return Object.fromEntries(
      Object.entries(parsed).filter(([_, v]) => typeof v === 'string'),
    ) as Record<string, string>
  } catch {
    return undefined
  }
}

function createClient(deps: CliDeps, config: Config, ctx: Ctx): VisionClient {
  if (deps.createClient) return deps.createClient(config)
  // Lazy: a cache-hit replay makes zero vision calls and needs no key. The
  // error fires clearly on the first actual model call.
  let inner: OpenRouterClient | undefined
  return {
    complete: async (opts) => {
      if (inner === undefined) {
        const apiKey = ctx.env.OPENROUTER_API_KEY
        if (apiKey === undefined || apiKey === '') {
          throw new Error(
            'OPENROUTER_API_KEY is not set — every vision call is billed through this key (BYOK)',
          )
        }
        const envTrace = parseOpenRouterTrace(ctx.env)
        const trace = { ...(envTrace ?? {}), ...(config.openrouter?.trace ?? {}) }
        const headers = { ...(config.openrouter?.headers ?? {}) }
        const traceOpt = Object.keys(trace).length > 0 ? trace : undefined
        const headersOpt = Object.keys(headers).length > 0 ? headers : undefined
        inner = new OpenRouterClient({
          apiKey,
          ...(traceOpt ? { trace: traceOpt } : {}),
          ...(headersOpt ? { headers: headersOpt } : {}),
          onCall: (call) => {
            ctx.out(
              `openrouter ${call.kind} ${call.model} ${call.tokens}tok $${call.costUsd.toFixed(6)}`,
            )
          },
        })
      }
      return inner.complete(opts)
    },
  }
}

async function launchDriver(config: Config, deps: CliDeps): Promise<BrowserDriver> {
  if (deps.launchDriver) return deps.launchDriver(config)
  return BrowserDriver.launch({
    browser: config.browser,
    browserTimeoutMs: config.browserTimeoutMs,
  })
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
    ctx.err('record requires a flow description: argus-reviewer record "<flow>" --url <target>')
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
    driver = await launchDriver(config, deps)
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
        driver = await launchDriver(config, deps)
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
            calls: state.calls,
            videoPath: undefined,
          })
          await fileSession.save()
          ctx.out(`${ok ? 'PASS' : 'FAIL'} ${fileSlug} (${fileName})`)
          if (!ok && failureMessage !== undefined) ctx.err(`  reason: ${failureMessage}`)
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
              calls: state.calls,
              videoPath: undefined,
            })
            await session.save()
            ctx.out(`${ok ? 'PASS' : 'FAIL'} ${registeredTest.name} (${fileName})`)
            if (!ok && failureMessage !== undefined) ctx.err(`  reason: ${failureMessage}`)
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
          calls: [],
          videoPath: undefined,
        })
        ctx.out(`FAIL ${fileSlug} (${fileName})`)
        ctx.err(`  reason: ${(e as Error).message}`)
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

const CODE_REVIEW_SCHEMA: JsonSchema = {
  name: 'code-review',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      verdict: { type: 'string', enum: ['pass', 'needs_changes', 'approve'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'number' },
            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            message: { type: 'string' },
          },
          required: ['file', 'message', 'severity'],
        },
      },
    },
    required: ['summary', 'verdict', 'findings'],
  },
}

interface PrFile {
  filename: string
  patch?: string
}

interface CodeReviewReport {
  ok: boolean
  skipped: boolean
  summary: string
  verdict: 'pass' | 'needs_changes' | 'approve'
  findings: { file: string; line?: number; severity: string; message: string }[]
  calls: CallCost[]
  visionCostUsd: number
  tokens: number
  model: string
}

async function fetchPrDiff(repo: string, pr: string, token: string, ctx: Ctx): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${repo}/pulls/${pr}/files?per_page=100`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      ctx.err(`failed to fetch PR files: ${res.status} ${res.statusText}`)
      return undefined
    }
    const files = (await res.json()) as PrFile[]
    const patches = files
      .filter((f) => typeof f.patch === 'string' && f.patch.length > 0)
      .map((f) => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    if (patches.length === 0) return undefined
    return patches.join('\n\n')
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      ctx.err('failed to fetch PR files: request timed out after 30s')
      return undefined
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

function buildCodeReviewMessages(repo: string, pr: string, patchText: string): Message[] {
  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'You are a senior engineer reviewing a PR diff. Output terse, actionable findings. One line per issue. No throat-clearing.',
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Review the diff for ${repo}#${pr}.\n\n${patchText}\n\nReturn JSON: summary, verdict (pass/needs_changes/approve), and findings[].\n\nEach finding must include:\n- file\n- line\n- severity: bug | risk | nit | q\n- message: one line in this format: \`L<line>: <emoji> <severity>: <problem>. <fix>.\`\n\nSeverity emojis:\n- bug = 🔴\n- risk = 🟡\n- nit = 🔵\n- q = ❓\n\nRules for the message:\n- Start with \`L<line>: \`\n- Then the emoji and keyword, e.g. \`🔴 bug:\`, \`🟡 risk:\`, \`🔵 nit:\`, \`❓ q:\`\n- State the concrete problem and a concrete fix\n- No \\\"I noticed\\\", \\\"perhaps\\\", \\\"consider\\\", \\\"maybe\\\", \\\"you might want\\\"\n- Do not restate what the line does\n- Include the why only if the fix is not obvious\n- Put exact symbol/variable/function names in backticks\n\nVerdict rule:\n- If there are no bug or risk findings, use \"approve\".\n- Use \"needs_changes\" only when at least one bug or risk is present.\n- \"pass\" only when there are zero findings.\n\nDo not report issues that are already handled by try/catch, null guards, AbortController, type narrowing, or other existing error checks visible in the diff. Only report real, high-confidence problems.\n\nExamples:\nL42: 🔴 bug: \`user\` can be null after .find(). Add guard before .email.\nL88-140: 🔵 nit: 50-line fn does 4 things. Extract validate/normalize/persist.\nL23: 🟡 risk: no retry on 429. Wrap in withBackoff(3).`,
        },
      ],
    },
  ]
}

function deriveSeverity(message: string): string {
  if (message.includes('🔴') || /(?:^|\W)bug:/.test(message)) return 'bug'
  if (message.includes('🟡') || /(?:^|\W)risk:/.test(message)) return 'risk'
  if (message.includes('🔵') || /(?:^|\W)nit:/.test(message)) return 'nit'
  if (message.includes('❓') || /(?:^|\W)q:/.test(message)) return 'q'
  return 'nit'
}

function parseCodeReview(content: string): {
  summary: string
  verdict: 'pass' | 'needs_changes' | 'approve'
  findings: CodeReviewReport['findings']
} {
  const defaultFindings: CodeReviewReport['findings'] = []
  try {
    const parsed = JSON.parse(content) as {
      summary?: string
      verdict?: string
      findings?: CodeReviewReport['findings']
    }
    const validVerdict = ['pass', 'needs_changes', 'approve'].includes(parsed.verdict ?? '')
      ? (parsed.verdict as 'pass' | 'needs_changes' | 'approve')
      : (Array.isArray(parsed.findings) && parsed.findings.length === 0 ? 'pass' : 'needs_changes')
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((f) => ({
          ...f,
          severity: (f as { severity?: string }).severity ?? deriveSeverity((f as { message?: string }).message ?? ''),
        }))
      : defaultFindings
    return {
      summary: parsed.summary ?? (validVerdict === 'pass' ? 'No issues found' : 'Code review completed'),
      verdict: validVerdict,
      findings,
    }
  } catch {
    return {
      summary: 'Code review completed but could not parse the model response',
      verdict: 'needs_changes',
      findings: defaultFindings,
    }
  }
}

async function cmdCodeReview(args: string[], ctx: Ctx, deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'report-dir': { type: 'string' },
    },
  })
  if (values.help) {
    ctx.out(CODE_REVIEW_USAGE)
    return 0
  }

  const config = await loadConfig(ctx.cwd)
  const reportDir = resolve(
    ctx.cwd,
    values['report-dir'] ?? config.reportDir ?? 'vision-e2e-report',
  )
  await mkdir(reportDir, { recursive: true })
  const codeReviewPath = join(reportDir, 'code-review.json')

  const trace = parseOpenRouterTrace(ctx.env)
  const repo = (trace?.repo ?? ctx.env.GITHUB_REPOSITORY) as string | undefined
  const pr = trace?.pr
  const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN

  const skip = async (reason: string): Promise<number> => {
    ctx.out(`code-review: skipping — ${reason}`)
    const skipped: CodeReviewReport = {
      ok: true,
      skipped: true,
      summary: `Code review skipped — ${reason}`,
      verdict: 'pass',
      findings: [],
      calls: [],
      visionCostUsd: 0,
      tokens: 0,
      model: config.code_model ?? config.model,
    }
    await writeFile(codeReviewPath, `${JSON.stringify(skipped, null, 2)}\n`, 'utf8')
    return 0
  }

  if (!repo || !pr) return await skip('missing repo/pr in trace')
  if (!token) return await skip('missing GITHUB_TOKEN')

  const patchText = await fetchPrDiff(repo, pr, token, ctx)
  if (!patchText) return await skip('could not fetch PR diff')

  try {
    const client = createClient(deps, config, ctx)
    const model = config.code_model ?? config.model
    const response = await client.complete({
      model,
      messages: buildCodeReviewMessages(repo, pr, patchText),
      schema: CODE_REVIEW_SCHEMA,
      kind: 'code',
    })
    const { summary, verdict, findings } = parseCodeReview(response.content)
    const hasBug = findings.some((f) => (f as { severity?: string }).severity === 'bug')
    const report: CodeReviewReport = {
      ok: !hasBug,
      skipped: false,
      summary,
      verdict,
      findings,
      calls: [response.cost],
      visionCostUsd: response.cost.costUsd,
      tokens: response.cost.tokens,
      model: response.model,
    }
    await writeFile(codeReviewPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    ctx.out(
      `code review complete: ${findings.length} findings, verdict ${verdict}, ` +
        `${response.cost.tokens}tok $${response.cost.costUsd.toFixed(6)}`,
    )
    return 0
  } catch (e) {
    ctx.err(`code review failed: ${(e as Error).message}`)
    return 1
  }
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
      console.error(`argus-reviewer: ${(e as Error).message}`)
      process.exitCode = 1
    })
}
