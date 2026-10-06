import { TdSession, HealEvent, bindSession, takeTests } from '../api.js'
import { FingerprintRecord } from '../cache/fingerprint.js'
import { parseBudgetSetting, applyBudgetSetting, UNCAPPED_WARNING } from '../config.js'
import { detectEnvironment } from '../detect.js'
import { BrowserDriver, PageCapture } from '../driver/browser.js'
import { TargetProcess } from '../driver/target.js'
import { Actions } from '../engine/actions.js'
import { type ExploreResult, runExplore } from '../engine/explore.js'
import { VisionClient } from '../engine/loop.js'
import { fetchPrMeta } from '../evidence/ci.js'
import { isLoopback, runA0Task, a0TaskPrompt, A0_DEFAULT_TIMEOUT_MS } from '../executor/a0.js'
import { FlowWriteback, writebackHealsToPr, writebackHealsLocal } from '../flow/writeback.js'
import { diffChangedFiles } from '../index/diff.js'
import { invalidateForDiff } from '../index/invalidate.js'
import { readIndex } from '../index/scan.js'
import { buildJournalEntry } from '../journal/build.js'
import { ErrorRecord } from '../journal/schema.js'
import { newRunId, writeJournal } from '../journal/store.js'
import { liveLog } from '../live.js'
import { createLogger, resolveLogLevel } from '../log.js'
import { JunitCase, writeJunitXml } from '../report/junit.js'
import { TestReport, buildRunReport, writeRunReport } from '../report/run.js'
import { shortSha } from '../report/viewmodel.js'
import { renderSummary } from '../ui/summary.js'
import { CallCost } from '../vision/cost.js'
import { Ledger } from '../vision/ledger.js'
import { discoverTestFiles, patchGlobals, applyPageSetup, importTestFile, restoreGlobals } from './record.js'
import { displayPath } from './review-shared.js'
import { type Ctx, type CliDeps, RUN_USAGE, parseKeepAliveTtl, usageError, KEEP_ALIVE_DEFAULT_TTL_MS, resolveCheckoutTrust, loadCliConfig, warnUnknownProviders, envOr, gitInfo, startTarget, createClient, TEST_FILE_RE, launchDriver, slugify, A0_HEAL_BUDGET_MS, A0_HEAL_MAX_DELEGATIONS, parseOpenRouterTrace, reportError, maybeKeepAliveHold, runNonceFrom } from './shared.js'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, join, relative, basename, sep } from 'node:path'
import { parseArgs } from 'node:util'


export async function cmdRun(args: string[], ctx: Ctx, deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      url: { type: 'string' },
      dir: { type: 'string' },
      'report-dir': { type: 'string' },
      'cache-dir': { type: 'string' },
      'keep-alive': { type: 'boolean', default: false },
      'keep-alive-ttl': { type: 'string' },
    },
  })
  if (values.help) {
    ctx.out(RUN_USAGE)
    return 0
  }
  const keepAliveTtlMs = parseKeepAliveTtl(values['keep-alive-ttl'])
  if (values['keep-alive-ttl'] !== undefined && keepAliveTtlMs === undefined) {
    usageError(
      ctx,
      'run',
      `--keep-alive-ttl must be a positive integer of seconds, got "${values['keep-alive-ttl']}"`,
    )
    return 2
  }
  const keepAlive =
    values['keep-alive'] === true || keepAliveTtlMs !== undefined
      ? { ttlMs: keepAliveTtlMs ?? KEEP_ALIVE_DEFAULT_TTL_MS }
      : undefined

  const trustResult = await resolveCheckoutTrust(ctx)
  const { trust } = trustResult
  const config = await loadCliConfig(ctx, trust)
  warnUnknownProviders(config, ctx)
  if (values['cache-dir'] !== undefined) {
    config.cacheDir = resolve(ctx.cwd, values['cache-dir'])
  }
  const envBudget = ctx.env.ARGUS_BUDGET_USD
  const envSetting = parseBudgetSetting(envBudget)
  if (envSetting.kind === 'invalid') {
    ctx.err(`warning: ignoring invalid ARGUS_BUDGET_USD="${envBudget}"`)
  }
  const applied = applyBudgetSetting(envSetting)
  if (applied !== 'keep') config.budgetUsd = applied
  if (config.budgetUsd === undefined) ctx.err(UNCAPPED_WARNING)
  // Action input surface: 'pr' enables write-back, 'off' disables, anything
  // else warns and defers to config. The trusted-lane gate still owns the
  // actual write.
  const envHealWriteback = envOr(ctx.env.ARGUS_HEAL_WRITEBACK)
  if (envHealWriteback === 'pr' || envHealWriteback === 'off') {
    config.flow.healWriteback = envHealWriteback
  } else if (envHealWriteback !== undefined) {
    ctx.err(`warning: ignoring invalid ARGUS_HEAL_WRITEBACK="${envHealWriteback}"`)
  }

  const liveDir = resolve(ctx.cwd, config.cacheDir ?? '.argus-reviewer-cache')
  // liveLog's mkdir is non-recursive by design — create a custom nested
  // cache dir (and ancestors) here once so the first live write lands.
  try {
    await mkdir(liveDir, { recursive: true })
  } catch {
    /* liveLog stays best-effort */
  }
  const logger = createLogger(
    resolveLogLevel(ctx.env, config.logLevel),
    ctx,
    (l, m) => liveLog(liveDir, 'run', l, m),
    ctx.style,
  )
  const runErrors: ErrorRecord[] = []
  const runId = newRunId()
  const startedAt = new Date()

  const url = values.url ?? config.target?.url
  if (url === undefined) {
    usageError(
      ctx,
      'run',
      'no target URL: pass --url or set config.target.url',
      `${ctx.rerun} --url http://localhost:3000`,
    )
    return 2
  }

  const pattern = positionals[0]
  const testsDir = resolve(ctx.cwd, values.dir ?? config.testsDir ?? 'tests')
  const flowsDir = join(testsDir, 'flows')
  const reportDir = resolve(
    ctx.cwd,
    values['report-dir'] ?? config.reportDir ?? 'argus-reviewer-report',
  )
  const allFiles = await discoverTestFiles(testsDir)
  const files = pattern === undefined ? allFiles : allFiles.filter((f) => f.includes(pattern))

  // Diff-aware invalidation (fast path): when the index and a diff are
  // available, mark flow fingerprints stale so they re-ground proactively.
  // Index missing or unreadable → content-hash verification remains the
  // backstop and the run proceeds unchanged.
  let staleReason: string | undefined
  {
    const indexPath = resolve(ctx.cwd, config.indexPath ?? 'argus.index.json')
    const testPaths = allFiles.map((f) => relative(ctx.cwd, f))
    const [index, changed] = await Promise.all([
      readIndex(indexPath),
      diffChangedFiles(ctx.cwd, config.diffBase ?? ctx.env.ARGUS_DIFF_BASE),
    ])
    const result = invalidateForDiff(changed, index, config.sourceGlobs, testPaths)
    if (result.stale && result.reason !== undefined) {
      staleReason = result.reason
      logger.info(`diff invalidation: ${result.reason}`)
    } else if (index === undefined) {
      logger.debug(`no usable index at ${indexPath}; hash verification only`)
    }
  }

  if (files.length === 0) {
    ctx.out(`no test files found under ${testsDir}`)
    ctx.err(`no test files found under ${testsDir}; run reports a failure rather than a pass`)
  }

  const runStart = Date.now()
  const reports: TestReport[] = []
  const junitCases: JunitCase[] = []
  const tmpDir = join(reportDir, '.transpiled')
  const tagErrors = (recs: ErrorRecord[], tag: string): ErrorRecord[] =>
    recs.map((r) => ({ ...r, context: r.context ? `${r.context} [${tag}]` : tag }))
  // One driver serves a whole test file — captures are file-session scoped,
  // attached to every report produced under that session (observed findings,
  // never verdict-changing).
  const attachCaptures = (d: BrowserDriver, file: string): void => {
    const caps = d.pageCaptures()
    if (caps.length === 0) return
    for (const r of reports) {
      if (r.file === file && r.captures === undefined) r.captures = caps
    }
  }
  const makeSession = (flowName: string, driver: BrowserDriver, client: VisionClient) =>
    TdSession.create({
      driver,
      client,
      config,
      flowName,
      flowsDir,
      env: ctx.env,
      ...(staleReason !== undefined ? { staleReason } : {}),
      logger,
    })

  // Heal write-back (flow.healWriteback): sessions that healed collect their
  // before/after records here; sanitized relocations are proposed back to
  // the committed recordings once the lane finishes.
  const writebackFlows: FlowWriteback[] = []
  const collectWriteback = (session: TdSession, flowName: string): void => {
    if (config.flow.healWriteback !== 'pr') return
    const heals = session.healEvents.filter(
      (
        e,
      ): e is HealEvent & { index: number; before: FingerprintRecord; after: FingerprintRecord } =>
        e.index !== undefined && e.before !== undefined && e.after !== undefined,
    )
    if (heals.length === 0) return
    writebackFlows.push({
      flowName,
      steps: session.fingerprintRecords,
      asserts: session.assertEntries,
      heals: heals.map((e) => ({ index: e.index, before: e.before, after: e.after })),
    })
  }

  // Evidence store: one immutable journal record per run — attempted on
  // every exit path, including an aborted test loop.
  let headSha: string | undefined
  const journalize = async (): Promise<void> => {
    const git = await gitInfo(ctx.cwd)
    headSha = git.commitSha
    const entry = buildJournalEntry({
      runId,
      repo: git.repo,
      commitSha: git.commitSha,
      branch: git.branch,
      startedAt,
      durationMs: Date.now() - runStart,
      reports,
      runErrors,
      ok: !runFailed,
    })
    const cacheDir = resolve(ctx.cwd, config.cacheDir ?? '.argus-reviewer-cache')
    const path = await writeJournal(cacheDir, entry)
    if (path !== undefined) {
      logger.debug(`journal written: ${path}`)
    } else {
      logger.warn('journal write failed; check fs permissions or disk space')
    }
  }

  let runFailed = false
  let target: TargetProcess | undefined
  // Exploratory act pass (U4b) outcome — populated inside the try so an
  // argus-booted target is still alive, merged into report.explore below.
  let exploreOutcome:
    | {
        result: ExploreResult
        captures: PageCapture[]
        calls: CallCost[]
        budgetExceeded: boolean
        videoPath: string | undefined
      }
    | undefined
  let exploreSkipped: string | undefined
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
        const fileSession = await makeSession(fileSlug, driver, client)
        bindSession(fileSession)
        await driver.goto(url)
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
          // Fail closed on zero evidence: a file that registers no tests and
          // records no steps/asserts produced nothing a reviewer can trust.
          const noEvidence = fileSession.steps.length === 0 && fileSession.asserts.length === 0
          const ok = importError === undefined && !fileSession.failed && !noEvidence
          const failureMessage =
            importError?.message ??
            (fileSession.failed ? fileSession.failureReason : undefined) ??
            (noEvidence
              ? 'no evidence — file registered no tests and recorded no steps or assertions'
              : undefined)
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
            cache: fileSession.cacheStats,
          })
          await fileSession.save()
          collectWriteback(fileSession, fileSlug)
          runErrors.push(...tagErrors(fileSession.errorRecords, fileSlug))
          ctx.out(`${ok ? 'PASS' : 'FAIL'} ${fileSlug} (${fileName})`)
          if (!ok && failureMessage !== undefined) ctx.err(`  reason: ${failureMessage}`)
        } else {
          for (const registeredTest of registered) {
            // Generated tests name their single test after the flow and the
            // file alike (`smoke-flow` inside `smoke-flow.test.ts`); binding
            // the file-level flow lets a recorded flow replay cache-first on
            // its very first run instead of missing on `<file>__<test>`.
            const sessionFlowName =
              slugify(registeredTest.name) === fileSlug
                ? fileSlug
                : `${fileSlug}__${slugify(registeredTest.name)}`
            const session = await makeSession(sessionFlowName, driver, client)
            bindSession(session)
            session.ledger.startSandbox()
            const testStart = Date.now()
            let error: Error | undefined
            try {
              await driver.goto(url)
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
              cache: session.cacheStats,
            })
            await session.save()
            collectWriteback(session, sessionFlowName)
            runErrors.push(...tagErrors(session.errorRecords, registeredTest.name))
            ctx.out(`${ok ? 'PASS' : 'FAIL'} ${registeredTest.name} (${fileName})`)
            if (!ok && failureMessage !== undefined) ctx.err(`  reason: ${failureMessage}`)
          }
        }

        attachCaptures(driver, file)
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
        if (driver !== undefined) attachCaptures(driver, file)
      } finally {
        await driver?.close()
        bindSession(undefined)
      }
    }

    // Exploratory act pass (U4b): after the test sessions, a bounded
    // free-explore loop probes the app itself — its own driver session so
    // captures are attributed to the lane, not to a test file. Runs inside
    // the try so an argus-booted target is still alive. Any failure here
    // degrades to report.explore.skipped — exploration never fails the run.
    if (config.explore.enabled) {
      let exploreDriver: BrowserDriver | undefined
      try {
        exploreDriver = await launchDriver(config, deps)
        await applyPageSetup(config, exploreDriver, ctx, tmpDir)
        const targetUrl = url
        await exploreDriver.goto(targetUrl)
        const exploreLedger = new Ledger(config.explore.budgetUsd ?? config.budgetUsd)
        const result = await runExplore({
          driver: exploreDriver,
          actions: new Actions(exploreDriver),
          client,
          ledger: exploreLedger,
          config,
          targetUrl,
          logger,
        })
        runErrors.push(...result.notes)
        const captures = exploreDriver.pageCaptures()
        const calls = exploreLedger.calls
        ctx.out(
          `explore: ${result.steps.length} steps, ${result.visited} page(s), ` +
            `stopped: ${result.stopReason}, $${result.visionCostUsd.toFixed(6)}`,
        )
        // Record the outcome before close() — a video-finalize failure must
        // not hide a completed explore pass (the error still lands in
        // runErrors via the catch).
        exploreOutcome = {
          result,
          captures,
          calls,
          budgetExceeded: exploreLedger.budgetExceeded,
          videoPath: undefined,
        }
        const videoPath = await exploreDriver.close()
        exploreDriver = undefined
        exploreOutcome.videoPath = videoPath
      } catch (e) {
        exploreSkipped = (e as Error).message
        runErrors.push({ stage: 'explore', message: `explore skipped: ${exploreSkipped}` })
        ctx.err(`explore skipped: ${exploreSkipped}`)
      } finally {
        await exploreDriver?.close()
      }
    }

    // heal: 'a0' — each failed test gets an autonomous second opinion from
    // the Agent Zero instance: it clicks through the app itself and reports
    // whether the app or the expectation is wrong. Runs inside the try so an
    // argus-booted target is still alive; bounded by a shared deadline so N
    // failures cannot block the run for N × timeout.
    const failedReports = reports.filter((r) => !r.ok)
    if (config.heal === 'a0' && failedReports.length > 0) {
      const env = await detectEnvironment(ctx.env, {
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
      })
      const a0Host = config.a0?.url ?? env.a0.host
      if (env.a0.version === undefined && a0Host === undefined) {
        ctx.err('heal: a0 configured but no Agent Zero found; install the a0 CLI or set a0.url')
      } else if (
        a0Host !== undefined &&
        url !== undefined &&
        isLoopback(url) &&
        !isLoopback(a0Host)
      ) {
        ctx.err(
          `heal: a0 host ${a0Host} is remote but the target ${url} is loopback; delegations skipped`,
        )
      } else {
        // Two Argus-side ceilings on remote spend (#53): a shared wall-clock
        // deadline AND a delegation count — N failures can't produce N
        // unbounded agent runs. Dollar caps live in the A0 gateway config.
        const deadline = Date.now() + A0_HEAL_BUDGET_MS
        const maxDelegations = config.a0?.maxTasks ?? A0_HEAL_MAX_DELEGATIONS
        let delegations = 0
        for (const r of failedReports) {
          if (delegations >= maxDelegations) {
            ctx.err(
              `heal: a0 delegation cap reached (${maxDelegations}); remaining failures get no diagnosis`,
            )
            break
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            ctx.err('heal: a0 budget exhausted; remaining failures get no diagnosis')
            break
          }
          const res = await runA0Task(
            a0TaskPrompt(
              `A browser test named "${r.name}" just failed against this app ` +
                `(reason: ${r.failureMessage ?? 'unknown'}). Click through the ` +
                `intended flow yourself and report concisely whether the app is ` +
                `broken or the test expectation is stale.`,
              url,
            ),
            {
              host: a0Host,
              timeoutMs: Math.min(remaining, A0_DEFAULT_TIMEOUT_MS),
              ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
            },
          )
          delegations++
          if (res.ok) {
            r.a0Diagnosis = res.output
            ctx.out(`a0 diagnosis for "${r.name}": ${res.output}`)
          } else {
            ctx.err(`a0 delegation failed for "${r.name}": ${res.output}`)
          }
        }
      }
    }

    // Heal write-back: propose sanitized healed recordings back to the repo.
    // Trusted lanes only — an untrusted (fork) lane never holds a write
    // token, and a working-tree write under a hostile checkout is still a
    // write the PR's own code influenced. Never fails the run.
    if (config.flow.healWriteback === 'pr' && writebackFlows.length > 0) {
      try {
        if (trust !== 'trusted') {
          ctx.err('heal write-back: skipped; untrusted lane cannot write back')
        } else {
          const wbToken = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN
          const wbTrace = parseOpenRouterTrace(ctx.env)
          const wbRepo = wbTrace?.repo ?? envOr(ctx.env.GITHUB_REPOSITORY)
          const wbPr = wbTrace?.pr || trustResult.pr
          const flowsRelDir = relative(ctx.cwd, flowsDir).split(sep).join('/')
          const wbSha = (await gitInfo(ctx.cwd)).commitSha
          let wbBase = envOr(ctx.env.GITHUB_BASE_REF) ?? envOr(ctx.env.GITHUB_REF_NAME)
          if (
            wbBase === undefined &&
            wbRepo !== undefined &&
            wbToken !== undefined &&
            wbPr !== undefined
          ) {
            wbBase = (await fetchPrMeta(wbRepo, wbPr, wbToken, ctx))?.baseRef
          }
          if (wbRepo !== undefined && wbToken !== undefined && wbBase !== undefined) {
            const outcome = await writebackHealsToPr(
              writebackFlows,
              flowsRelDir,
              {
                repo: wbRepo,
                baseRef: wbBase,
                token: wbToken,
                headSha: wbSha,
                ...(wbPr !== undefined ? { pr: wbPr } : {}),
              },
              ctx,
            )
            if (outcome.skipped !== undefined) {
              ctx.out(`heal write-back: ${outcome.skipped}`)
            } else if (outcome.result !== undefined) {
              ctx.out(
                `heal write-back: ${outcome.result.existing === true ? 'updated' : 'opened'} ${outcome.result.prUrl}`,
              )
            }
          } else {
            const outcome = await writebackHealsLocal(writebackFlows, flowsDir, ctx)
            if (outcome.skipped !== undefined) {
              ctx.out(`heal write-back: ${outcome.skipped}`)
            } else {
              ctx.out(
                `heal write-back: updated ${relative(ctx.cwd, flowsDir)}; ` +
                  `review the git diff before committing`,
              )
            }
          }
        }
      } catch (e) {
        ctx.err(`heal write-back failed: ${(e as Error).message}`)
      }
    }
  } catch (e) {
    reportError(ctx, e, 'run', 'COMMAND_FAILED')
    runFailed = true
  } finally {
    restoreGlobals(patches)
    if (keepAlive !== undefined && (runFailed || reports.some((r) => !r.ok))) {
      await maybeKeepAliveHold(ctx, deps, target, url, keepAlive.ttlMs)
    }
    await target?.stop()
    // Transpiled modules are pid-tagged per run — remove the whole dir or
    // stale copies accumulate inside the report directory consumers archive.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
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
  const report = buildRunReport(
    reports,
    startedAt,
    Date.now() - runStart,
    exploreOutcome?.calls ?? [],
    // Explore counts as evidence only when the pass completed — a skipped
    // or errored pass observed nothing and must not green the run.
    exploreOutcome !== undefined && exploreOutcome.result.stopReason !== 'error',
    runNonceFrom(ctx.env),
  )
  if (config.explore.enabled) {
    if (exploreOutcome !== undefined) {
      // An errored pass is reported as an explicit skip — 'stopped: error'
      // alone doesn't read as a failure. Its calls, captures, and video are
      // still kept: spend already billed stays in the totals.
      const errored = exploreOutcome.result.stopReason === 'error'
      report.explore = {
        enabled: true,
        ...(errored
          ? {
              skipped: exploreOutcome.result.notes.at(-1)?.message ?? 'exploration error',
            }
          : {
              steps: exploreOutcome.result.steps.length,
              visited: exploreOutcome.result.visited,
              stopReason: exploreOutcome.result.stopReason,
              visionCalls: exploreOutcome.result.visionCalls,
              visionCostUsd: exploreOutcome.result.visionCostUsd,
            }),
        ...(exploreOutcome.captures.length > 0 ? { captures: exploreOutcome.captures } : {}),
        ...(exploreOutcome.videoPath !== undefined ? { videoPath: exploreOutcome.videoPath } : {}),
      }
      if (exploreOutcome.budgetExceeded) report.totals.budgetExceeded = true
      if (exploreOutcome.videoPath !== undefined) {
        report.artifacts.videos.push(exploreOutcome.videoPath)
      }
    } else {
      // Explicit skip line when the lane could not observe anything: either
      // the act pass failed to reach the target, or every test report
      // failed before a single step ran so no page ever loaded.
      const pageLoaded = reports.some((r) => r.ok || r.steps.length > 0)
      const skipped =
        exploreSkipped !== undefined
          ? `no reachable target — ${exploreSkipped}`
          : pageLoaded || reports.length === 0
            ? undefined
            : 'no page loaded — nothing captured'
      report.explore = {
        enabled: true,
        ...(skipped !== undefined ? { skipped } : {}),
      }
    }
  }
  try {
    await mkdir(reportDir, { recursive: true })
    await writeJunitXml(join(reportDir, 'junit.xml'), 'argus-reviewer', junitCases)
    await writeRunReport(join(reportDir, 'run.json'), report)
  } catch (e) {
    // Report-write failure must not eat the journal — the journal is the
    // evidence store for exactly this kind of failure.
    const msg = `report write failed: ${(e as Error).message}`
    runErrors.push({ stage: 'report', message: msg })
    ctx.err(msg)
    runFailed = true
  }
  await journalize()

  const ok = report.ok && !runFailed
  if (ctx.nested !== true) {
    // R13: end with the summary block. Inside verify, verify prints it.
    const heals = reports.reduce((n, r) => n + r.healEvents.length, 0)
    const status = ok ? 'passed' : 'failed'
    const summary = renderSummary(
      {
        status,
        headSha: shortSha(headSha),
        durationMs: report.durationMs,
        lanes: [
          {
            lane: 'flow',
            status,
            detail:
              `${report.totals.passed}/${report.totals.tests} tests passed` +
              (heals > 0 ? `, ${heals} healed` : ''),
            costUsd: report.totals.visionCostUsd,
            metered: true,
            limitUsd: config.budgetUsd,
            spentUsd: report.totals.visionCostUsd,
            exceeded: report.totals.budgetExceeded,
          },
        ],
        totalUsd: report.totals.visionCostUsd,
        budgetUsd: config.budgetUsd,
        reportPath: displayPath(ctx, join(reportDir, 'run.json')),
      },
      ctx.style,
      ctx.width,
    )
    for (const line of summary) ctx.out(line)
  }
  return ok ? 0 : 1
}
