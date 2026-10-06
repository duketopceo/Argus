import { parseInstructions, checkRequestTimeoutMs, parseBudgetSetting, applyBudgetSetting, UNCAPPED_WARNING, resolveBlockSeverities, resolveBatchModel, resolveMaxComments } from '../config.js'
import { setLiveDir, debug } from '../debug.js'
import { defaultExec } from '../detect.js'
import { type PrMeta, fetchPrMeta, fetchCheckRuns } from '../evidence/ci.js'
import { linkFindings } from '../evidence/link.js'
import { writeAtomicJson } from '../fsutil.js'
import { buildReviewContext } from '../index/context.js'
import { readIndex } from '../index/scan.js'
import { liveLog } from '../live.js'
import { affordableBatchPrefix } from '../pipeline/budget.js'
import { type GenerateLaneResult, runGenerateLane } from '../probe/generate.js'
import { encodeProbePayload } from '../probe/persist.js'
import { type ProbeRecord, runProbeLane } from '../probe/queue.js'
import { classifyHeadBinding, readCheckoutSha, isHeadBindingConclusive } from '../report/manifest.js'
import { type FindingAdjudicationAudit, adjudicateFindings } from '../review/adjudicate.js'
import { planChunks } from '../review/chunks.js'
import { isReviewProfile } from '../review/packs.js'
import { type RuleFinding, runRules } from '../review/rules.js'
import { partitionByExclude, rulesForFiles } from '../review/scope.js'
import { type SecretsScanResult, materializeMergeBaseDiff } from '../review/secrets.js'
import { capTestFindings } from '../review/testfiles.js'
import { type TriageRecord, triagePr, buildTriageState, routeModel, triageAreaSignal } from '../review/triage.js'
import { type ValidationAudit, validateFindings, auditOf } from '../review/validate.js'
import { CallCost } from '../vision/cost.js'
import { DecisionClient } from '../vision/decisions.js'
import { Ledger } from '../vision/ledger.js'
import { BatchItemResult } from '../vision/openrouter.js'
import { type PrFile, type CodeReviewReport, loadFixture, loadLocalDiff, resolveIncrementalBaseline, fetchPrFiles, diffLineRanges, diffLineTexts, type DroppedFinding, type ReviewFinding, type ReviewBatch, buildCodeReviewMessages, CODE_REVIEW_SCHEMA, parseCodeReview, filterToDiffLines, filterRevertNits, buildSynthesisMessages, carryForwardSuggestions, type ReviewScope, computeReviewEvent, renderReviewComments } from './review-shared.js'
import { type Ctx, type CliDeps, CODE_REVIEW_USAGE, parseOpenRouterTrace, resolveCheckoutTrust, loadCliConfig, usageError, runNonceFrom, createClient, reportError } from './shared.js'
import { mkdir } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { parseArgs } from 'node:util'


export async function cmdCodeReview(args: string[], ctx: Ctx, deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'report-dir': { type: 'string' },
      fixture: { type: 'string' },
      base: { type: 'string' },
      full: { type: 'boolean', default: false },
      mode: { type: 'string' },
      'batch-model': { type: 'string' },
      'generate-tests': { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    ctx.out(CODE_REVIEW_USAGE)
    return 0
  }

  // Trust resolves BEFORE config load — a hostile tree's .ts config must
  // never execute beside the runner's secrets (#58). The inputs need no
  // config: pull_request* events read fork status from the event payload,
  // issue_comment derives `pr` from `issue.number` (ARGUS_REVIEWER_TRACE.pr
  // is empty on that event — the action builds it from
  // github.event.pull_request.number).
  const trace = parseOpenRouterTrace(ctx.env)
  const trustResult = await resolveCheckoutTrust(ctx)
  const config = await loadCliConfig(ctx, trustResult.trust)
  // Stage lines stream to <cacheDir>/live.ndjson — unconditional (liveLog
  // never throws), so `npm run watch` can follow a running review. Route
  // debug() writes to the same dir now that the configured one is known.
  const liveDir = resolve(ctx.cwd, config.cacheDir ?? '.argus-reviewer-cache')
  setLiveDir(liveDir)
  const stage = (msg: string): void => liveLog(liveDir, 'code-review', 'info', msg)
  stage(`trust=${trustResult.trust} config loaded`)
  const reportDir = resolve(
    ctx.cwd,
    values['report-dir'] ?? config.reportDir ?? 'argus-reviewer-report',
  )
  await mkdir(reportDir, { recursive: true })
  const codeReviewPath = join(reportDir, 'code-review.json')

  // --fixture <dir>: review a local fixture repo (argus-fixture-base vs
  // HEAD) with zero GitHub API calls — the demo path. Trust still resolves
  // (locally → trusted) and every downstream lane runs its real code.
  const fixtureDir = values.fixture !== undefined ? resolve(ctx.cwd, values.fixture) : undefined
  const baseFlag = values.base?.trim()
  if (fixtureDir !== undefined && baseFlag !== undefined && baseFlag !== '') {
    usageError(
      ctx,
      'code-review',
      '--base cannot be combined with --fixture',
      'argus-reviewer code-review --base main',
    )
    return 2
  }
  // --base reviews the local merge-base..worktree diff with zero GitHub
  // context (U16). diffBase/ARGUS_DIFF_BASE supply the default base only
  // when no PR context exists — that config already feeds flow-lane diff
  // invalidation and must not silently hijack a real PR lane.
  const traceRepo = trace?.repo ?? ctx.env.GITHUB_REPOSITORY
  const tracePr = trace?.pr || trustResult.pr
  const baseToken = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN
  const configuredBase = (config.diffBase ?? '').trim() || (ctx.env.ARGUS_DIFF_BASE ?? '').trim()
  const hasPrContext =
    traceRepo !== undefined &&
    traceRepo !== '' &&
    tracePr !== undefined &&
    tracePr !== '' &&
    baseToken !== undefined &&
    baseToken !== ''
  const localBaseRef =
    fixtureDir === undefined
      ? baseFlag !== undefined && baseFlag !== ''
        ? baseFlag
        : hasPrContext
          ? undefined
          : configuredBase !== ''
            ? configuredBase
            : undefined
      : undefined
  const repo =
    fixtureDir !== undefined
      ? basename(fixtureDir)
      : localBaseRef !== undefined
        ? basename(ctx.cwd)
        : (traceRepo as string | undefined)
  // `||` not `??`: the action renders `pr` as "" on issue_comment events
  // (github.event.pull_request.number is empty), and '' is not nullish.
  const pr = fixtureDir !== undefined || localBaseRef !== undefined ? '0' : tracePr
  const token = baseToken
  // ARGUS_CODE_MODEL is an operator surface (workflow/plugin env) and wins
  // over checkout config — in the untrusted lane it is the only way to pick
  // the review model, since PR-controlled config never executes.
  const envCodeModel = ctx.env.ARGUS_CODE_MODEL?.trim()
  if (envCodeModel !== undefined && envCodeModel !== '') config.code_model = envCodeModel
  // ARGUS_REVIEW_PROFILES (comma-separated lens names) follows the same
  // operator-env pattern as ARGUS_CODE_MODEL — the only way to pick lenses
  // in the untrusted lane.
  const envProfiles = ctx.env.ARGUS_REVIEW_PROFILES?.trim()
  if (envProfiles !== undefined && envProfiles !== '') {
    config.review.profiles = envProfiles
      .split(',')
      .map((s) => s.trim())
      .filter(isReviewProfile)
  }
  // ARGUS_REVIEW_INSTRUCTIONS (JSON [{glob, rule}]) follows the same
  // operator-env pattern — the only lever in the untrusted lane. Invalid
  // JSON or a malformed entry warns and keeps the config value.
  const envInstructions = ctx.env.ARGUS_REVIEW_INSTRUCTIONS?.trim()
  if (envInstructions !== undefined && envInstructions !== '') {
    try {
      config.review.instructions = parseInstructions(JSON.parse(envInstructions))
    } catch (e) {
      ctx.err(`warning: ignoring invalid ARGUS_REVIEW_INSTRUCTIONS: ${(e as Error).message}`)
    }
  }
  // Review mode: --mode beats the operator env, which beats config (same
  // operator-env pattern as ARGUS_CODE_MODEL — the only lever in the
  // untrusted lane, where PR-controlled config never executes).
  const modeRaw = (values.mode ?? ctx.env.ARGUS_REVIEW_MODE ?? '').trim()
  if (modeRaw === 'realtime' || modeRaw === 'batch') config.review.mode = modeRaw
  else if (modeRaw !== '') {
    if (values.mode !== undefined) {
      usageError(
        ctx,
        'code-review',
        `--mode must be realtime or batch, got "${modeRaw}"`,
        'argus-reviewer code-review --mode batch',
      )
      return 2
    }
    ctx.err(`warning: ignoring invalid ARGUS_REVIEW_MODE="${modeRaw}"`)
  }
  const batchModelRaw = (values['batch-model'] ?? ctx.env.ARGUS_BATCH_MODEL ?? '').trim()
  if (batchModelRaw !== '') config.review.batchModel = batchModelRaw
  const timeoutRaw = ctx.env.ARGUS_REQUEST_TIMEOUT_MS?.trim()
  if (timeoutRaw !== undefined && timeoutRaw !== '') {
    const ms = /^\d+$/.test(timeoutRaw) ? Number(timeoutRaw) : Number.NaN
    const bad = checkRequestTimeoutMs(ms)
    if (bad !== undefined) {
      usageError(
        ctx,
        'code-review',
        `ARGUS_REQUEST_TIMEOUT_MS: ${bad.replace('requestTimeoutMs', 'value')}, got "${timeoutRaw}"`,
        'ARGUS_REQUEST_TIMEOUT_MS=300000 argus-reviewer code-review',
      )
      return 2
    }
    config.review.requestTimeoutMs = ms
  }
  const model = config.code_model ?? config.model
  const runNonce = runNonceFrom(ctx.env)
  debug(
    'code-review',
    `repo=${repo ?? 'none'} pr=${pr ?? 'none'} model=${model} budget=${config.codeReviewBudgetUsd ?? 'UNCAPPED'}`,
  )

  // Declared before `skip` so the empty-diff skip report can carry the
  // reviewed range; populated after the PR-context guard below.
  let localReview:
    | { files: PrFile[]; meta: PrMeta & { headSha: string; baseSha: string }; diff: string }
    | { error: string }
    | undefined = undefined

  const skip = async (
    reason: string,
    extra?: { reviewedHeadSha?: string; incremental?: CodeReviewReport['incremental'] },
  ): Promise<number> => {
    ctx.out(`code-review: skipping: ${reason}`)
    stage(`skipped — ${reason}`)
    const skipped: CodeReviewReport = {
      ok: true,
      skipped: true,
      summary: `Code review skipped: ${reason}`,
      verdict: 'pass',
      findings: [],
      reviewEvent: 'comment',
      provenBlockers: 0,
      highConfidenceBlockers: 0,
      reviewComments: [],
      commentsOverflow: 0,
      calls: [],
      visionCostUsd: 0,
      tokens: 0,
      model,
      budgetExceeded: false,
      headBinding: classifyHeadBinding(
        undefined,
        undefined,
        fixtureDir !== undefined ? 'fixture' : localBaseRef !== undefined ? 'local' : 'github',
      ),
      ...(localReview !== undefined && !('error' in localReview)
        ? {
            diffRange: {
              base: localBaseRef as string,
              baseSha: localReview.meta.baseSha,
              headSha: localReview.meta.headSha,
            },
          }
        : {}),
      ...(extra?.reviewedHeadSha !== undefined ? { reviewedHeadSha: extra.reviewedHeadSha } : {}),
      ...(extra?.incremental !== undefined ? { incremental: extra.incremental } : {}),
      ...(runNonce !== undefined ? { runNonce } : {}),
    }
    await writeAtomicJson(codeReviewPath, skipped)
    return 0
  }

  if (fixtureDir === undefined && localBaseRef === undefined) {
    if (!repo || !pr) {
      return await skip(
        'missing repo/pr in trace; pass --base <ref> or set diffBase to review the local diff',
      )
    }
    if (!token) return await skip('missing GITHUB_TOKEN')
  }

  const indexPath = resolve(fixtureDir ?? ctx.cwd, config.indexPath ?? 'argus.index.json')
  const fixture = fixtureDir !== undefined ? await loadFixture(fixtureDir, deps.exec) : undefined
  if (fixture !== undefined && 'skipped' in fixture) {
    return await skip(`fixture: ${fixture.skipped}`)
  }
  localReview =
    localBaseRef !== undefined
      ? await loadLocalDiff(ctx.cwd, localBaseRef, deps.exec ?? defaultExec, {
          excludeDirs: [liveDir, reportDir],
        })
      : undefined
  if (localReview !== undefined && 'error' in localReview) {
    usageError(
      ctx,
      'code-review',
      localReview.error,
      `argus-reviewer code-review --base ${localBaseRef}`,
    )
    return 2
  }
  // Narrowed: fixture mode sets both; the guards above return early in
  // live-PR mode when either is missing.
  const repoName = repo as string
  const prNum = pr as string
  const ghToken = token as string
  const envBudget = ctx.env.ARGUS_BUDGET_USD
  const envSetting = parseBudgetSetting(envBudget)
  if (envSetting.kind === 'invalid') {
    ctx.err(`warning: ignoring invalid ARGUS_BUDGET_USD="${envBudget}"`)
  }
  const appliedBudget = applyBudgetSetting(envSetting)
  if (appliedBudget !== 'keep') config.codeReviewBudgetUsd = appliedBudget
  const budget = config.codeReviewBudgetUsd
  if (budget === undefined) ctx.err(UNCAPPED_WARNING)
  // PR metadata resolves before the file fetch — U4 needs headSha to verify
  // the sticky baseline, and triage/evidence/head-binding reuse the same
  // promise below (fixture/local modes supply it synchronously).
  const prMetaPromise =
    fixture !== undefined
      ? Promise.resolve(fixture.meta)
      : localReview !== undefined
        ? Promise.resolve(localReview.meta)
        : fetchPrMeta(repoName, prNum, ghToken, ctx).catch(() => undefined)
  // U4 incremental review — PR mode only. A verified sticky baseline swaps
  // the pulls/files diff for `compare(lastReviewed..head)`; every failure
  // fails closed to the full PR diff with a named reason in the report.
  const prMetaEarly = await prMetaPromise
  let incremental: CodeReviewReport['incremental']
  let prFiles: PrFile[] | undefined
  if (fixture === undefined && localReview === undefined) {
    const headShaEarly = prMetaEarly?.headSha
    const fullRequested = values.full === true || ctx.env.ARGUS_REVIEW_FULL === '1'
    const baseline =
      !fullRequested && headShaEarly !== undefined
        ? await resolveIncrementalBaseline(repoName, prNum, headShaEarly, ghToken, ctx)
        : undefined
    if (baseline?.kind === 'equal' && headShaEarly !== undefined) {
      return await skip(
        `head ${headShaEarly.slice(0, 8)} is unchanged since the last Argus review`,
        {
          reviewedHeadSha: headShaEarly,
          incremental: { since: baseline.since as string, commits: 0 },
        },
      )
    }
    if (baseline?.kind === 'incremental') {
      incremental = {
        since: baseline.since as string,
        ...(baseline.commits !== undefined ? { commits: baseline.commits } : {}),
      }
      prFiles = baseline.files
      stage(
        `incremental review - ${baseline.commits ?? '?'} commit(s) since ` +
          `${(baseline.since as string).slice(0, 8)}`,
      )
    } else {
      if (baseline?.rejected !== undefined) {
        incremental = { rejected: baseline.rejected }
        ctx.err(`warning: ${baseline.rejected} - reviewing the full diff`)
      }
      prFiles = await fetchPrFiles(repoName, prNum, ghToken, ctx)
    }
  }
  const [allFiles, index] = await Promise.all([
    fixture !== undefined
      ? Promise.resolve(fixture.files)
      : localReview !== undefined
        ? Promise.resolve(localReview.files)
        : Promise.resolve(prFiles),
    readIndex(indexPath),
  ])
  if (!allFiles || allFiles.length === 0) {
    return await skip(
      incremental?.since !== undefined
        ? `no file changes since last reviewed head ${incremental.since.slice(0, 8)}`
        : localReview !== undefined
          ? `no diff vs base ${localBaseRef}`
          : 'could not fetch PR diff',
      // An empty incremental range never advances the baseline marker —
      // dropped patches on the compare side are indistinguishable from a
      // genuinely empty range, so the stored SHA stays and the next run
      // re-verifies.
      incremental !== undefined ? { incremental } : undefined,
    )
  }
  stage(
    fixture !== undefined
      ? `fixture mode — ${allFiles.length} changed file(s) from ${basename(fixtureDir as string)}`
      : localReview !== undefined
        ? `local diff - ${allFiles.length} changed file(s) vs ${localBaseRef}`
        : incremental?.since !== undefined
          ? `${allFiles.length} changed file(s) since ${incremental.since.slice(0, 8)}`
          : `fetched ${allFiles.length} changed file(s)`,
  )
  // Generated/fixture/vendored paths never reach the review model; the
  // count and a sample land in the report's scope record (never silent).
  const { kept: files, excluded } = partitionByExclude(allFiles, config.review.exclude)
  if (excluded.length > 0) {
    stage(`excluded ${excluded.length} file(s) by review.exclude`)
  }
  if (files.length === 0) {
    return await skip(`all ${allFiles.length} changed file(s) match review.exclude`)
  }

  const contexts = buildReviewContext(
    index,
    files.map((f) => ({ filename: f.filename, previousFilename: f.previous_filename })),
  )
  const attached = Object.keys(contexts).length
  if (attached > 0) {
    debug('code-review', `contexts=${attached}/${files.length}`)
  }

  const plan = planChunks(files, contexts)
  const chunks = plan.map((c) => c.text)
  debug('code-review', `chunks=${chunks.length} files=${files.length}`)

  try {
    const client = createClient(deps, config, ctx)
    const ledger = new Ledger(budget)
    // Checkout SHA still kicks off here — its `git` call overlaps the model
    // round-trips. prMeta was hoisted above the file fetch for the U4
    // baseline check; the same resolved promise feeds evidence + binding.
    const checkoutShaPromise =
      fixture !== undefined
        ? Promise.resolve(undefined)
        : readCheckoutSha(ctx.cwd, deps.exec ?? defaultExec)
    const allFindings: CodeReviewReport['findings'] = []
    const allCalls: CallCost[] = []
    let totalTokens = 0
    let totalCost = 0
    let lastModel = model

    // Shared spend sink — chunk, synthesis, probe, and every decide()
    // call funnel through here so the ledger/report never drift. The
    // over-budget flag lives here too: a decide() that crosses the cap
    // must trip it just like a chunk does, or later lanes keep spending.
    const recordSpend = (c: CallCost): void => {
      ledger.recordCall(c)
      allCalls.push(c)
      totalTokens += c.tokens
      totalCost += c.costUsd
      if (budget !== undefined && ledger.visionCostUsd > budget) {
        ledger.flagBudgetExceeded()
      }
    }

    const apiKey = ctx.env.OPENROUTER_API_KEY
    const decisionClient =
      config.decisionModel !== undefined && apiKey !== undefined && apiKey !== ''
        ? new DecisionClient({
            apiKey,
            ...(trace !== undefined ? { trace } : {}),
            onCall: (c) =>
              recordSpend({
                model: c.model,
                provider: c.provider,
                tokens: c.tokens,
                costUsd: c.costUsd,
                kind: 'decide',
              }),
          })
        : undefined

    // U7 triage lane — one batched confidence-model decide(). 'route' needs the
    // signal before chunk review to pick the model tier, so it awaits
    // here; 'annotate' (default) overlaps the decide() round-trip with
    // the chunk loop and resolves before the probe lane below. The confidence model
    // routes/annotates, never gates: every chunk is still reviewed.
    let reviewModel = model
    let triage: TriageRecord | undefined
    // Hoisted so the !== 'off' narrowing reaches the closure below.
    const triageMode = config.review.triage
    const triagePromise =
      decisionClient !== undefined && triageMode !== 'off'
        ? prMetaPromise
            .then((metaEarly) =>
              triagePr({
                client: decisionClient,
                ...(config.decisionModel !== undefined ? { model: config.decisionModel } : {}),
                state: buildTriageState({
                  title: metaEarly?.title,
                  body: metaEarly?.body,
                  files,
                }),
                mode: triageMode,
              }),
            )
            .catch((e) => {
              // triagePr already degrades DecisionError internally —
              // reaching here means a chain bug (e.g. buildTriageState
              // threw); keep the breadcrumb so it isn't invisible.
              debug('triage', `triage chain failed: ${(e as Error).message}`)
              return undefined
            })
        : undefined
    const triageLine = (t: TriageRecord): string =>
      `triage — risk ${t.risk ?? '?'}, deep-review ${t.needsDeepReview?.toFixed(2) ?? '?'}, ` +
      `area ${t.topRiskArea ?? '?'}` +
      (t.unadjudicated === true ? ' (unadjudicated)' : '')
    if (config.review.triage === 'route' && triagePromise !== undefined) {
      triage = await triagePromise
      const routed = routeModel({
        record: triage,
        configured: model,
        lowRiskModel: config.review.lowRiskModel,
      })
      reviewModel = routed.model
      if (triage !== undefined) stage(`${triageLine(triage)} — ${routed.reason}`)
    }
    stage(`reviewing ${chunks.length} chunk(s) — model ${reviewModel}`)

    // Findings must anchor to lines the diff shows — a cite outside every
    // hunk (or in a file the diff doesn't touch) is unverifiable and
    // unpostable. Filter at parse and again after synthesis. Verdict-
    // driving findings are exempt from anchoring — a misnumbered cite on
    // a real defect must still gate; post-time isOnDiff keeps its comment
    // off the PR.
    const blockSeverities = resolveBlockSeverities(config)
    const diffRanges = diffLineRanges(files)
    const diffTexts = diffLineTexts(files)
    let droppedUnanchored = 0
    let droppedReverted = 0
    const droppedFindings: DroppedFinding[] = []
    const recordDrops = (ds: readonly ReviewFinding[], reason: DroppedFinding['reason']) => {
      for (const f of ds) {
        if (droppedFindings.length >= 50) break
        droppedFindings.push({
          file: f.file,
          severity: f.severity,
          message: f.message.slice(0, 300),
          reason,
          ...(f.line !== undefined ? { line: f.line } : {}),
          ...(f.category !== undefined ? { category: f.category } : {}),
        })
      }
    }

    // Batch mode: all chunks go out as one async batch up front. A whole-
    // batch failure (or timeout) leaves `batched` empty so every chunk runs
    // realtime below; a single errored request falls back for that chunk
    // only. Synthesis stays realtime — it needs the merged chunk findings.
    const batched = new Map<number, BatchItemResult['result']>()
    let batchRecord: ReviewBatch | undefined
    if (config.review.mode === 'batch') {
      if (client.completeBatch === undefined || chunks.length === 0) {
        batchRecord = {
          used: false,
          chunks: chunks.length,
          fellBack: 'client has no batch support',
        }
      } else {
        const allRequests = chunks.map((chunk, i) => ({
          customId: `chunk-${i}`,
          messages: buildCodeReviewMessages(
            repoName,
            prNum,
            chunk,
            i,
            chunks.length,
            config.review.profiles,
            rulesForFiles(config.review.instructions, plan[i]?.files ?? []),
          ),
          schema: CODE_REVIEW_SCHEMA,
          provider: config.provider,
        }))
        // A submitted batch cannot be stopped, so size it against the
        // remaining budget first (conservative token-based estimate). Chunks
        // past the prefix run realtime below, where the per-chunk budget
        // gate applies.
        const fit = affordableBatchPrefix(allRequests, budget, ledger.visionCostUsd)
        const requests = allRequests.slice(0, fit)
        if (fit < allRequests.length) {
          ctx.err(
            fit === 0
              ? `code-review: batch skipped: projected cost of ${allRequests.length} chunk(s) exceeds the $${budget} budget; using realtime with budget checks`
              : `code-review: batch limited to ${fit} of ${allRequests.length} chunk(s): projected cost exceeds the $${budget} budget; the rest run realtime with budget checks`,
          )
        }
        if (fit === 0) {
          batchRecord = {
            used: false,
            chunks: chunks.length,
            fellBack: 'projected batch cost exceeds budget',
          }
        } else
          try {
            stage(
              `submitting ${requests.length} chunk(s) as a batch, poll deadline ${Math.round(config.review.batchTimeoutMs / 1000)}s`,
            )
            const batchModel = resolveBatchModel(reviewModel, config.review.batchModel)
            stage(`batch model ${batchModel}`)
            const items = await client.completeBatch({
              model: batchModel,
              requests,
              kind: 'code',
              deadlineMs: config.review.batchTimeoutMs,
            })
            items.forEach((item, i) => {
              if (item.result !== undefined) batched.set(i, item.result)
            })
            batchRecord = {
              used: true,
              chunks: chunks.length,
              retriedRealtime: chunks.length - batched.size,
            }
            if (batched.size < chunks.length) {
              ctx.err(
                `code-review: ${chunks.length - batched.size} batch request(s) failed; running those chunks realtime`,
              )
            }
          } catch (e) {
            const reason = (e as Error).message
            debug('code-review', `batch failed: ${reason}`)
            ctx.err(`code-review: batch failed (${reason}); falling back to realtime`)
            batchRecord = { used: false, chunks: chunks.length, fellBack: reason }
          }
      }
    }

    const reviewedChunks = new Set<number>()
    let chunkSpend = 0
    for (let i = 0; i < chunks.length; i++) {
      const fromBatch = batched.get(i)
      // Batch results are already paid for: always take them. Only
      // realtime chunks are gated by the budget.
      if (fromBatch === undefined) {
        if (ledger.budgetExceeded) continue
        // Stop BEFORE a chunk the remaining budget cannot be expected to
        // cover (projected at the mean cost so far) — checking only after
        // the spend lets every run overshoot its cap by a whole chunk.
        if (reviewedChunks.size > 0 && !ledger.canSpend(chunkSpend / reviewedChunks.size)) {
          ctx.err(`code-review: budget would be exceeded by chunk ${i + 1}; stopping early`)
          continue
        }
      }
      debug('code-review', `chunk=${i + 1}/${chunks.length}`)
      const chunk = chunks[i]
      if (chunk === undefined) continue
      const response =
        fromBatch ??
        (await client.complete({
          model: reviewModel,
          messages: buildCodeReviewMessages(
            repoName,
            prNum,
            chunk,
            i,
            chunks.length,
            config.review.profiles,
            rulesForFiles(config.review.instructions, plan[i]?.files ?? []),
          ),
          schema: CODE_REVIEW_SCHEMA,
          kind: 'code',
          provider: config.provider,
        }))
      recordSpend(response.cost)
      chunkSpend += response.cost.costUsd
      reviewedChunks.add(i)
      lastModel = response.model
      const parsed = parseCodeReview(response.content)
      const anchored = filterToDiffLines(parsed.findings, diffRanges, blockSeverities)
      droppedUnanchored += anchored.dropped.length
      recordDrops(anchored.dropped, 'outside-diff')
      const vetted = filterRevertNits(anchored.kept, diffTexts, blockSeverities)
      droppedReverted += vetted.dropped.length
      recordDrops(vetted.dropped, 'revert-nit')
      if (anchored.dropped.length + vetted.dropped.length > 0) {
        debug(
          'code-review',
          `chunk ${i + 1}: dropped ${anchored.dropped.length} outside-diff, ${vetted.dropped.length} revert-nit finding(s)`,
        )
      }
      allFindings.push(...vetted.kept)
      stage(`chunk ${i + 1}/${chunks.length} — ${parsed.findings.length} finding(s)`)
      if (ledger.budgetExceeded && fromBatch === undefined) {
        ctx.err(`code-review: budget exceeded after chunk ${i + 1}; stopping early`)
      }
    }
    const chunksReviewed = reviewedChunks.size

    let modelVerdict: 'pass' | 'needs_changes' | 'approve' | undefined
    let modelSummary: string | undefined
    let finalFindings = allFindings

    // Synthesis is paid too: project it at the mean chunk cost.
    const synthAllowed =
      !ledger.budgetExceeded &&
      (reviewedChunks.size === 0 || ledger.canSpend(chunkSpend / reviewedChunks.size))
    if (chunks.length > 1 && synthAllowed) {
      try {
        debug('code-review', 'synthesis')
        stage('synthesizing chunk findings')
        const synthResponse = await client.complete({
          model: reviewModel,
          messages: buildSynthesisMessages(
            repoName,
            prNum,
            files.map((f) => f.filename),
            allFindings,
          ),
          schema: CODE_REVIEW_SCHEMA,
          kind: 'code',
          provider: config.provider,
        })
        recordSpend(synthResponse.cost)
        lastModel = synthResponse.model
        const parsed = parseCodeReview(synthResponse.content)
        modelSummary = parsed.summary
        modelVerdict = parsed.verdict
        finalFindings =
          parsed.findings.length > 0
            ? carryForwardSuggestions(parsed.findings, allFindings)
            : allFindings
        const anchored = filterToDiffLines(finalFindings, diffRanges, blockSeverities)
        droppedUnanchored += anchored.dropped.length
        recordDrops(anchored.dropped, 'outside-diff')
        const vetted = filterRevertNits(anchored.kept, diffTexts, blockSeverities)
        droppedReverted += vetted.dropped.length
        recordDrops(vetted.dropped, 'revert-nit')
        finalFindings = vetted.kept
        // The model's summary describes the set it emitted — reuse it only
        // when this pass dropped nothing, else its prose can cite findings
        // that were filtered out.
        if (anchored.dropped.length + vetted.dropped.length > 0) modelSummary = undefined
        if (ledger.budgetExceeded) {
          ctx.err('code-review: budget exceeded after synthesis; stopping early')
        }
      } catch (e) {
        debug('code-review', `synthesis failed: ${(e as Error).message}`)
        ctx.err(`code-review synthesis failed: ${(e as Error).message}`)
      }
    }

    // Verdict describes the emitted findings against the operator's gate,
    // derived post-filter and post-union on every path — a filtered-out
    // finding can never flip the gate open (dropped bug -> 'pass') nor
    // leave an inconsistent 'needs_changes' over an empty findings list.
    // R8: verdict, ok, and reviewEvent describe one finding set, so the
    // derivation sits AFTER the rules-lane union below — the union is
    // deferred past adjudication so model output can never erase a
    // deterministic hit, and a pre-union verdict would diverge from the
    // gate. The model's own verdict is recorded when it diverges, never
    // trusted.
    const reviewedSet = new Set(plan.flatMap((c, i) => (reviewedChunks.has(i) ? c.files : [])))
    const unreviewed = files.length - reviewedSet.size
    const scope: ReviewScope = {
      totalFiles: allFiles.length,
      reviewedFiles: reviewedSet.size,
      excludedFiles: excluded.length,
      excludedSample: excluded.slice(0, 5).map((f) => f.filename),
      chunksTotal: chunks.length,
      chunksReviewed,
      unreviewedFiles: unreviewed,
    }

    // Deterministic validation: anchors outside the reviewed diff are
    // dropped before any adjudication spend. Counted, never silent.
    let validation: ValidationAudit | undefined
    let testFileCapped = 0
    {
      const checked = validateFindings(
        finalFindings,
        files,
        new Set(excluded.map((f) => f.filename)),
      )
      const capped = capTestFindings(
        checked.kept,
        files.map((f) => f.filename),
      )
      testFileCapped = capped.capped
      if (checked.dropped.length > 0 || capped.capped > 0) {
        finalFindings = capped.findings
        if (checked.dropped.length > 0) {
          validation = auditOf(checked.dropped)
          stage(`validation dropped ${checked.dropped.length} finding(s) outside the diff`)
        }
        if (capped.capped > 0) {
          stage(`capped ${capped.capped} test-file finding(s) at nit`)
        }
      }
    }
    // Annotate-mode triage overlapped the chunk loop — resolve it here,
    // before the probe lane and report read the record.
    if (triage === undefined && triagePromise !== undefined) {
      triage = await triagePromise
      if (triage !== undefined) stage(triageLine(triage))
    }

    // U8 finding adjudication — one batched confidence-model noul per synthesized
    // finding. Runs on the model findings only (rules-lane findings carry
    // their own adjudication or severity ceiling) and BEFORE the rules
    // union below so a suppressed nit can never reach a rule record.
    // bug/risk are never suppressed, so adjudication cannot move the
    // verdict — it derives from the post-union set below. Kicked off as
    // a promise — its decide() round-trip
    // overlaps the rules lane's materialize+scan below (the two lanes are
    // independent; results apply in order: adjudication, then union).
    // Skipped when the budget is already blown — no trailing spend.
    // blockSeverities (resolved above, before the anchor filters) flows
    // in so a user-blocking severity (e.g. a config severity list
    // containing 'nit') can never be suppressed — Jev must not be able
    // to flip the commit-status gate.
    let findingAdjudication: FindingAdjudicationAudit | undefined
    const adjudicationPromise =
      decisionClient !== undefined && !ledger.budgetExceeded && finalFindings.length > 0
        ? adjudicateFindings({
            findings: finalFindings,
            patchByFile: new Map(files.map((f) => [f.filename, f.patch ?? ''])),
            threshold: config.review.findingThreshold,
            blockSeverities,
            client: decisionClient,
            ...(config.decisionModel !== undefined ? { model: config.decisionModel } : {}),
          })
        : undefined

    // B.1 evidence linkage: tag each finding with whether the PR's own CI
    // exercised the implicated path. Post-pass annotation only — evidence
    // never downgrades a finding, and check-run names are sanitized before
    // they reach the comment.
    // prMeta also carries isFork/authorAssociation/labels — the B.2 probe
    // lane's fork gate (evidence/gate.ts) consumes them; only headSha feeds
    // evidence linkage here.
    const prMeta = await prMetaPromise
    const checkoutSha = await checkoutShaPromise
    const headBinding = classifyHeadBinding(
      prMeta?.headSha,
      checkoutSha,
      fixture !== undefined ? 'fixture' : localReview !== undefined ? 'local' : 'github',
    )
    stage(`head binding — ${headBinding.status}: ${headBinding.detail}`)

    // U8 — deterministic ruleset lane: pure rules over the local
    // merge-base diff — the PR-files API `patch` omits large/binary
    // files, so the local diff is the complete scan surface. Findings
    // union into finalFindings AFTER the synthesis replacement above so
    // a prompt-injected synthesis can never erase them; a throwing rule
    // degrades to a failure audit entry and the lane completes. Literals
    // are masked in every output (confidence-model `state` is the
    // documented exception).
    let secretsScan: SecretsScanResult | { skipped: string } | undefined
    let rulesScan: CodeReviewReport['rulesScan']
    const rulesFindings: RuleFinding[] = []
    // U4 — an incremental run scans the incremental range, not the whole
    // merge-base diff: already-reviewed commits stay out of scope.
    const scanBaseSha = incremental?.since ?? prMeta?.baseSha
    if (scanBaseSha !== undefined && config.review.rules.length > 0) {
      // Fixture mode already produced the same `git diff base..HEAD`
      // output inside the fixture repo — reuse it rather than shelling
      // out again (the scan surface is identical).
      const materialized =
        fixture !== undefined
          ? { diff: fixture.diff }
          : localReview !== undefined
            ? { diff: localReview.diff }
            : await materializeMergeBaseDiff({
                cwd: ctx.cwd,
                baseSha: scanBaseSha,
                ...(token !== undefined ? { token } : {}),
                ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
              })
      if ('skipped' in materialized) {
        secretsScan = { skipped: materialized.skipped }
        rulesScan = { skipped: materialized.skipped }
        ctx.err(`rules scan skipped: ${materialized.skipped}`)
        stage(`rules scan skipped: ${materialized.skipped}`)
      } else {
        const result = await runRules(materialized.diff, {
          enabled: config.review.rules,
          secretsThreshold: config.review.secretsThreshold,
          ...(decisionClient !== undefined ? { decisionClient } : {}),
          ...(config.decisionModel !== undefined ? { decisionModel: config.decisionModel } : {}),
        })
        secretsScan =
          result.secretsScan ??
          (result.ran.includes('secrets')
            ? { skipped: 'the secrets rule failed; see rulesScan.failures' }
            : result.ran.length === 0
              ? { skipped: 'the rules lane is disabled (review.rules)' }
              : { skipped: 'the secrets rule is not enabled (review.rules)' })
        rulesScan = {
          ran: result.ran,
          records: result.records,
          failures: result.failures,
        }
        if (result.findings.length > 0) {
          ctx.err(`rules scan: ${result.findings.length} finding(s)`)
        }
        for (const f of result.failures) {
          ctx.err(`rules scan: rule ${f.rule} threw: ${f.error}`)
        }
        stage(
          `rules scan: ${result.ran.length} rule(s), ` +
            `${result.records.length} audited hit(s), ` +
            `${result.findings.length} finding(s)` +
            (result.failures.length > 0 ? `, ${result.failures.length} rule(s) failed` : ''),
        )
        // Union is deferred until adjudication resolves below —
        // suppressed nits leave before rules findings join.
        rulesFindings.push(...result.findings)
      }
    } else {
      // Distinguish "ran, clean" from "never ran" in the report — a
      // disabled lane must not pay the materialize (fetch+diff) cost.
      const skipped =
        config.review.rules.length === 0
          ? 'the rules lane is disabled (review.rules)'
          : 'no merge-base SHA, so the lane did not run'
      secretsScan = { skipped }
      rulesScan = { skipped }
    }

    // Resolve the deferred adjudication kicked off above, then union —
    // order preserved: adjudicated model findings first, rules after.
    if (adjudicationPromise !== undefined) {
      const adj = await adjudicationPromise
      finalFindings = adj.findings
      const { findings: _dropped, ...audit } = adj
      findingAdjudication = audit
      const suppressed = adj.records.filter((r) => r.suppressed === true).length
      stage(
        `finding adjudication — ${adj.records.length} scored, ${suppressed} suppressed` +
          (adj.unadjudicated === true ? ' (confidence model unavailable — none suppressed)' : '') +
          (adj.overflow > 0 ? `, +${adj.overflow} over cap` : ''),
      )
    }
    finalFindings = [...finalFindings, ...rulesFindings]

    // R8 — verdict/summary derive here, on the post-union set, so they
    // agree with ok/reviewEvent below. Model findings passed
    // validation/capping above; rules findings keep their own audit and
    // severity ceiling (the runner cannot claim `bug` without
    // adjudicated confidence).
    let verdict: 'pass' | 'needs_changes' | 'approve'
    let summary: string
    if (finalFindings.length === 0) {
      const dropped = droppedUnanchored + droppedReverted
      summary =
        dropped > 0
          ? `No issues found – ${dropped} model finding(s) dropped as off-diff or self-reverting`
          : 'No issues found'
      verdict = 'pass'
    } else if (finalFindings.some((f) => blockSeverities.includes(f.severity))) {
      summary = `${finalFindings.length} finding(s) include a blocking severity`
      verdict = 'needs_changes'
    } else {
      summary = `${finalFindings.length} low-severity finding(s)`
      verdict = 'approve'
    }
    if (modelVerdict === verdict && modelSummary !== undefined) summary = modelSummary
    // A budget stop leaves the tail of the plan unreviewed; the scope and
    // summary must say so. Decorations preserve pre-U8 ordering: coverage,
    // exclusions, validation drops, budget, head binding.
    if (chunks.length > 1) {
      const coverage =
        chunksReviewed === chunks.length
          ? `Reviewed all ${chunks.length} chunks (${reviewedSet.size} of ${files.length} files).`
          : `Reviewed ${chunksReviewed} of ${chunks.length} chunks (${reviewedSet.size} of ${files.length} files); ${unreviewed} file(s) were not reviewed.`
      summary = `${coverage} ${summary}`
    }
    if (excluded.length > 0) {
      summary = `Reviewed ${files.length} of ${allFiles.length} changed files (${excluded.length} excluded by review.exclude). ${summary}`
    }
    if (validation !== undefined && validation.dropped > 0) {
      summary = `${summary} ${validation.dropped} finding(s) dropped: anchored outside the reviewed diff.`
    }
    if (ledger.budgetExceeded) {
      summary = `Budget exceeded, review stopped early. ${summary}`
      if (verdict !== 'needs_changes') verdict = 'needs_changes'
    }
    if (!isHeadBindingConclusive(headBinding)) {
      summary = `Head binding inconclusive: ${summary}`
    }

    const headSha = prMeta?.headSha
    const checkRuns =
      headSha === undefined || fixture !== undefined || localReview !== undefined
        ? undefined
        : await fetchCheckRuns(repoName, headSha, ghToken, ctx)
    const linkedFindings = linkFindings(finalFindings, index, checkRuns)
    debug('code-review', `evidence: ${linkedFindings.map((f) => f.evidence.status).join(',')}`)
    stage(`evidence linked — ${linkedFindings.length} finding(s), verdict ${verdict}`)

    // ARGUS_MAX_COMMENTS (action input) overrides the config cap — the
    // workflow author controls it; an untrusted PR config can't reach it
    // anyway since `review` isn't on the untrusted allowlist.
    const maxComments = resolveMaxComments(ctx.env, config)

    // B.2 probe lane: authored tests executed in the Docker sandbox can
    // upgrade a not_exercised finding to `reproduced`. Strictly additive —
    // failures degrade to a detail note and the lane never changes verdict,
    // ok, or the exit code (KTD8). Opt-in via config.sandbox.enabled or the
    // ARGUS_SANDBOX=1 env flag (enable-only; other values leave config
    // authoritative).
    let probes: ProbeRecord[] | undefined
    let probeLaneSkipped: string | undefined
    const sandbox = {
      ...config.sandbox,
      enabled: config.sandbox.enabled || ctx.env.ARGUS_SANDBOX === '1',
    }
    // pull_request_target runs with the base repo's write token and ambient
    // secrets — the docs call the lane unsupported there; enforce it in
    // code too so a miswired workflow fails closed instead of executing
    // PR code beside real credentials.
    if (ctx.env.GITHUB_EVENT_NAME === 'pull_request_target') sandbox.enabled = false
    if (!isHeadBindingConclusive(headBinding)) {
      sandbox.enabled = false
      probeLaneSkipped = `head binding ${headBinding.status}: ${headBinding.detail}`
    }
    // Fixture mode reviews a local repo, not the cwd checkout — probes
    // would execute against the wrong tree.
    if (fixtureDir !== undefined && sandbox.enabled) {
      sandbox.enabled = false
      probeLaneSkipped = 'fixture mode: probes need a real PR checkout'
    }
    if (sandbox.enabled && !ledger.budgetExceeded) {
      try {
        stage('probe lane running')
        const lane = await runProbeLane(linkedFindings, {
          cwd: ctx.cwd,
          reportDir,
          sandbox,
          meta: prMeta,
          token: ghToken,
          client,
          // Probe authoring deliberately stays on the configured model —
          // triage routing is a review-depth decision, not an authoring one.
          model,
          provider: config.provider,
          ledger,
          budgetUsd: budget,
          severityGates: blockSeverities,
          // U9 — advisory only: a confident adjudicated triage area
          // reorders probe candidates toward the flagged subsystem.
          triageArea: triageAreaSignal(triage),
          index,
          calls: allCalls,
          exec: deps.exec,
          log: (line) => ctx.err(line),
        })
        if (lane !== undefined) {
          probes = lane.records
          probeLaneSkipped = lane.skipReason
          stage(
            lane.skipReason !== undefined
              ? `probe lane skipped — ${lane.skipReason}`
              : `probe lane done — ${lane.records.length} probe(s)`,
          )
          // Probe authoring spend lands on the shared ledger — the report's
          // headline cost fields must count it too or they understate the run.
          for (const p of lane.records) {
            totalCost += p.costUsd ?? 0
            totalTokens += p.tokens ?? 0
          }
        }
      } catch (e) {
        debug('code-review', `probe lane failed: ${(e as Error).message}`)
        ctx.err(`code-review probe lane failed: ${(e as Error).message}`)
      }
    }

    // U2 — diff-scoped spec generation: model-authored test leafs under
    // testsDir, sandbox-validated green on head when the checkout really
    // is the PR head, deposited on a reviewable PR via createFilesPr.
    // Opt-in via --generate-tests or review.generateTests.enabled. Fork
    // PRs are refused inside the lane; like probes it is strictly
    // additive — failures degrade to draft records and never touch the
    // verdict (KTD8).
    let generated: GenerateLaneResult | undefined
    const wantGenerate = values['generate-tests'] === true || config.review.generateTests.enabled
    if (wantGenerate) {
      try {
        stage('generate lane running')
        // Validation only proves something when the sandbox runs the real
        // PR head — a base checkout (mention lane) or inconclusive head
        // binding would "validate" the wrong tree, so those paths ship
        // unvalidated drafts instead.
        const genSandbox =
          fixtureDir === undefined && sandbox.enabled && isHeadBindingConclusive(headBinding)
            ? sandbox
            : undefined
        generated = await runGenerateLane({
          cwd: ctx.cwd,
          reportDir,
          testsDir: config.testsDir ?? 'tests',
          diff: files.map((f) => `--- ${f.filename}\n${f.patch ?? ''}`).join('\n'),
          changedPaths: files.map((f) => f.filename),
          sandbox: genSandbox,
          meta: prMeta,
          token: ghToken,
          // Fixture mode reviews a repo other than the checkout — writing
          // a PR against `repo` there would be fiction. Drafts only.
          // Local mode has no GitHub repo/pr to write against — drafts only.
          repo: fixtureDir === undefined && localReview === undefined ? repoName : undefined,
          pr: prNum,
          client,
          model,
          provider: config.provider,
          ledger,
          budgetUsd: config.review.generateTests.budgetUsd ?? budget,
          maxSpecs: config.review.generateTests.maxSpecs,
          index,
          calls: allCalls,
          exec: deps.exec,
          log: (line) => ctx.err(line),
        })
        totalCost += generated.costUsd
        totalTokens += generated.tokens
        stage(
          generated.skipReason !== undefined
            ? `generate lane skipped - ${generated.skipReason}`
            : `generate lane done - ${generated.records.length} spec record(s)` +
                (generated.prUrl !== undefined ? `, PR ${generated.prUrl}` : ''),
        )
      } catch (e) {
        debug('code-review', `generate lane failed: ${(e as Error).message}`)
        ctx.err(`code-review generate lane failed: ${(e as Error).message}`)
      }
    }

    // KTD2/KTD3 — the poster-facing surface is computed here, once, on
    // linkedFindings (post-probe `evidence`, adjudicated/carried `p`), and
    // serialized: posters read `reviewEvent` and POST `reviewComments`
    // verbatim rather than re-deriving render or gate policy.
    const gate = computeReviewEvent(linkedFindings, blockSeverities, config.review.requestChanges)
    const rendered = renderReviewComments(linkedFindings, maxComments)

    const hasBlocker = finalFindings.some((f) => blockSeverities.includes(f.severity))
    // E1.U3 — reproduced probes carry serialized source; embed the
    // machine-readable payload so a later `issue_comment` run can persist
    // them without a head checkout. Keyed to the reviewed head sha.
    const persistPayload = encodeProbePayload(probes, headBinding?.intendedSha)
    const report: CodeReviewReport = {
      ok: !hasBlocker && !ledger.budgetExceeded && isHeadBindingConclusive(headBinding),
      skipped: false,
      summary,
      verdict,
      findings: linkedFindings,
      reviewEvent: gate.reviewEvent,
      provenBlockers: gate.provenBlockers,
      highConfidenceBlockers: gate.highConfidenceBlockers,
      reviewComments: rendered.comments,
      commentsOverflow: rendered.overflow,
      ...(probes !== undefined ? { probes } : {}),
      ...(probeLaneSkipped !== undefined ? { probeLaneSkipped } : {}),
      ...(generated !== undefined ? { generated } : {}),
      ...(secretsScan !== undefined ? { secretsScan } : {}),
      ...(rulesScan !== undefined ? { rulesScan } : {}),
      ...(triage !== undefined ? { triage } : {}),
      ...(findingAdjudication !== undefined ? { findingAdjudication } : {}),
      ...(droppedUnanchored > 0 ? { droppedUnanchored } : {}),
      ...(droppedReverted > 0 ? { droppedReverted } : {}),
      ...(droppedFindings.length > 0 ? { droppedFindings } : {}),
      ...(modelVerdict !== undefined && modelVerdict !== verdict ? { modelVerdict } : {}),
      scope,
      ...(batchRecord !== undefined ? { batch: batchRecord } : {}),
      ...(validation !== undefined ? { validation } : {}),
      ...(testFileCapped > 0 ? { testFileCapped } : {}),
      maxComments,
      calls: allCalls,
      visionCostUsd: totalCost,
      tokens: totalTokens,
      model: lastModel,
      budgetExceeded: ledger.budgetExceeded,
      headBinding,
      // U4 — the baseline marker advances only on a completed, uncapped
      // review; skipped and budget-exceeded runs leave it where it was.
      ...(fixture === undefined && !ledger.budgetExceeded && headBinding?.intendedSha !== undefined
        ? { reviewedHeadSha: headBinding.intendedSha }
        : {}),
      ...(incremental !== undefined ? { incremental } : {}),
      ...(localReview !== undefined
        ? {
            diffRange: {
              base: localBaseRef as string,
              baseSha: localReview.meta.baseSha,
              headSha: localReview.meta.headSha,
            },
          }
        : fixture === undefined &&
            (incremental?.since ?? prMeta?.baseSha) !== undefined &&
            prMeta?.headSha !== undefined
          ? {
              diffRange: {
                base:
                  incremental?.since !== undefined
                    ? 'last-reviewed'
                    : (prMeta.baseRef ?? 'merge-base'),
                baseSha: (incremental?.since ?? prMeta.baseSha) as string,
                headSha: prMeta.headSha,
              },
            }
          : {}),
      ...(runNonce !== undefined ? { runNonce } : {}),
      ...(persistPayload !== undefined ? { persistPayload } : {}),
    }
    await writeAtomicJson(codeReviewPath, report)
    stage(
      `report written — verdict ${verdict}, ${linkedFindings.length} finding(s), ` +
        `$${totalCost.toFixed(6)}`,
    )
    ctx.out(
      `code review complete: ${finalFindings.length} findings, verdict ${verdict}, ` +
        `${totalTokens}tok $${totalCost.toFixed(6)}${ledger.budgetExceeded ? ' (budget exceeded)' : ''}`,
    )
    return 0
  } catch (e) {
    debug('code-review', `failed: ${(e as Error).message}`)
    stage(`failed: ${(e as Error).message}`)
    reportError(ctx, e, 'code-review', 'COMMAND_FAILED')
    return 1
  }
}
