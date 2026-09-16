import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import type { ProviderRules, Sandbox } from '../config.js'
import { defaultExec, type ExecFn } from '../detect.js'
import { mayProbePr } from '../evidence/gate.js'
import type { PrMeta } from '../evidence/ci.js'
import { isTestFile, type Evidence } from '../evidence/link.js'
import type { RepoIndex } from '../index/scan.js'
import type { VisionClient } from '../engine/loop.js'
import type { Ledger } from '../vision/ledger.js'
import { buildProbeMessages, parseProbe, PROBE_SCHEMA, type AuthoredProbe } from './author.js'
import { detectHarness, type Harness, type ProbeOutcome } from './harness.js'
import {
  checkSandboxPaths,
  dockerAvailable,
  resolveSandboxImage,
  runProbeInSandbox,
  SANDBOX_OUTPUT_CAP,
  SCRATCH_DIR_NAME,
  sandboxLimits,
} from '../executor/sandbox.js'

/**
 * The B.2 probe lane (U4). Called after `linkFindings` inside `code-review`.
 * Selects `not_exercised` blocking-severity findings, authors one probe each,
 * runs it in the sandbox against head AND a merge-base worktree, and upgrades
 * evidence to `reproduced` only on fail-head ∧ clean-base (KTD6). Everything
 * else leaves the finding untouched — additive evidence only, never a new
 * failure surface (KTD8): every error path degrades to a probe record or a
 * debug note, and the queue never changes verdict, ok, or exit code.
 */

export interface LinkedFinding {
  file?: string | undefined
  line?: number | undefined
  severity?: string | undefined
  message?: string | undefined
  evidence: Evidence
}

export type ProbeReportOutcome =
  | 'reproduced'
  | 'clean'
  | 'load-error'
  | 'not-collected'
  | 'error'

export interface ProbeRecord {
  /** Probe filename (basename — it is written beside the exemplar test). */
  file: string
  findingFile: string | undefined
  findingLine: number | undefined
  outcome: ProbeReportOutcome
  /** Raw harness outcomes per checkout, when the run happened ('error' = infra/timeout). */
  headOutcome?: ProbeOutcome | 'error' | undefined
  baseOutcome?: ProbeOutcome | 'error' | undefined
  durationMs: number
  costUsd: number
  detail: string
  /** Capped, control-char-stripped stdout+stderr for audit. */
  output?: string | undefined
}

export interface ProbeLaneOptions {
  /** PR checkout root (the head tree). */
  cwd: string
  reportDir: string
  sandbox: Sandbox
  /** `sandbox.enabled || ARGUS_SANDBOX=1`, resolved by the caller. */
  enabled: boolean
  meta: PrMeta | undefined
  token: string | undefined
  client: VisionClient
  model: string
  provider: ProviderRules | undefined
  /** Shared codeReviewBudgetUsd ledger — authoring calls record on it. */
  ledger: Ledger
  /** codeReviewBudgetUsd — authoring stops once spend reaches it. */
  budgetUsd: number | undefined
  /** Configured blocking severities — the queue only admits those. */
  severityGates: string[]
  index: RepoIndex | undefined
  exec?: ExecFn | undefined
  log?: ((line: string) => void) | undefined
  /** Host token used to fetch the base commit when not already present. */
  fetchBase?: ((baseSha: string) => Promise<boolean>) | undefined
}

/** Pure selection: not_exercised findings at blocking severities, capped. */
export function selectProbeTargets(
  findings: LinkedFinding[],
  severityGates: string[],
  maxProbes: number,
): LinkedFinding[] {
  return findings
    .filter(
      (f) =>
        f.evidence.status === 'not_exercised' &&
        f.file !== undefined &&
        severityGates.includes(f.severity ?? ''),
    )
    .slice(0, Math.max(0, maxProbes))
}

/**
 * Nearest existing test file to the finding's file — same directory first,
 * then same top-level segment, then any test file. The exemplar sets the
 * probe's write location so the consumer's own include/roots cover it.
 */
export function findExemplarTest(index: RepoIndex | undefined, findingFile: string): string | undefined {
  const tests = index?.entries.map((e) => e.path).filter(isTestFile) ?? []
  if (tests.length === 0) return undefined
  const dir = dirname(findingFile)
  const same = tests.find((t) => dirname(t) === dir)
  if (same !== undefined) return same
  const top = findingFile.split('/')[0]
  return tests.find((t) => t.split('/')[0] === top) ?? tests[0]
}

/**
 * Ensure `baseSha` is fetchable and checked out as a detached worktree at
 * `wtDir`. Returns the worktree path, or undefined when the base cannot be
 * materialized — probes then run head-only and can never mark `reproduced`.
 */
async function addBaseWorktree(
  exec: ExecFn,
  cwd: string,
  wtDir: string,
  baseSha: string,
  token: string | undefined,
): Promise<string | undefined> {
  const have = await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}^{commit}`], 15_000)
  if (have.code !== 0) {
    // Shallow PR checkouts lack the base — fetch it. Auth rides a one-off
    // extraheader like actions/checkout, so persist-credentials: false is
    // compatible.
    const args = ['-C', cwd]
    if (token !== undefined) {
      const auth = Buffer.from(`x-access-token:${token}`).toString('base64')
      args.push('-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`)
    }
    args.push('fetch', '--depth', '1', 'origin', baseSha)
    const fetched = await exec('git', args, 60_000)
    if (fetched.code !== 0) return undefined
  }
  const added = await exec('git', ['-C', cwd, 'worktree', 'add', '--detach', wtDir, baseSha], 60_000)
  return added.code === 0 ? wtDir : undefined
}

async function removeBaseWorktree(exec: ExecFn, cwd: string, wtDir: string): Promise<void> {
  const res = await exec('git', ['-C', cwd, 'worktree', 'remove', '--force', wtDir], 30_000)
  if (res.code !== 0) await rm(wtDir, { recursive: true, force: true }).catch(() => undefined)
}

/** One bounded authoring call; returns the validated probe or undefined. */
async function authorProbe(
  o: ProbeLaneOptions,
  target: LinkedFinding,
  harness: Harness,
  exemplarPath: string | undefined,
): Promise<{ probe: AuthoredProbe; costUsd: number } | { probe: undefined; reason: string }> {
  const fileContents =
    target.file === undefined
      ? undefined
      : await readFile(join(o.cwd, target.file), 'utf8').catch(() => undefined)
  const exemplar =
    exemplarPath === undefined
      ? undefined
      : {
          path: exemplarPath,
          content: await readFile(join(o.cwd, exemplarPath), 'utf8').catch(() => undefined),
        }
  const response = await o.client.complete({
    model: o.model,
    messages: buildProbeMessages(
      {
        file: target.file,
        line: target.line,
        severity: target.severity ?? 'bug',
        message: target.message ?? '',
      },
      fileContents,
      exemplar?.content === undefined ? undefined : { path: exemplar.path, content: exemplar.content },
      harness,
    ),
    schema: PROBE_SCHEMA,
    kind: 'code',
    ...(o.provider !== undefined ? { provider: o.provider } : {}),
  })
  o.ledger.recordCall(response.cost)
  const parsed = parseProbe(response.content)
  if (!parsed.ok) return { probe: undefined, reason: parsed.reason }
  return { probe: parsed.probe, costUsd: response.cost.costUsd }
}

function record(
  target: LinkedFinding,
  probe: AuthoredProbe | undefined,
  outcome: ProbeReportOutcome,
  detail: string,
  extra: Partial<ProbeRecord> = {},
): ProbeRecord {
  return {
    file: probe?.filename ?? '(none)',
    findingFile: target.file,
    findingLine: target.line,
    outcome,
    durationMs: extra.durationMs ?? 0,
    costUsd: extra.costUsd ?? 0,
    detail,
    ...(extra.headOutcome !== undefined ? { headOutcome: extra.headOutcome } : {}),
    ...(extra.baseOutcome !== undefined ? { baseOutcome: extra.baseOutcome } : {}),
    ...(extra.output !== undefined ? { output: extra.output } : {}),
  }
}

function probeOutput(stdout: string, stderr: string): string | undefined {
  const combined = `${stdout}\n${stderr}`.trim()
  return combined === '' ? undefined : combined.slice(0, SANDBOX_OUTPUT_CAP)
}

/**
 * Run the probe lane. Mutates `findings` evidence in place for reproduced
 * results and returns the per-probe audit records for code-review.json.
 */
export async function runProbeLane(
  findings: LinkedFinding[],
  o: ProbeLaneOptions,
): Promise<ProbeRecord[] | undefined> {
  const log = o.log ?? (() => undefined)
  if (!o.enabled) return undefined
  const sandbox: Sandbox = { ...o.sandbox, enabled: true }
  const targets = selectProbeTargets(findings, o.severityGates, sandbox.maxProbes)
  if (targets.length === 0) return undefined

  if (!mayProbePr(o.meta, sandbox)) {
    log('probes: skipped — fork gate (needs argus-probe label on this head or allowForks)')
    return undefined
  }
  const image = resolveSandboxImage(sandbox.image)
  const exec = o.exec ?? defaultExec
  if (!(await dockerAvailable(exec, image, o.cwd))) {
    log('probes: skipped — docker unavailable or cannot see the workspace')
    return undefined
  }
  const harness = await detectHarness(o.cwd)
  if (harness === undefined) {
    log('probes: skipped — no supported test harness (vitest/jest/node --test)')
    return undefined
  }
  const scratchDir = join(o.reportDir, SCRATCH_DIR_NAME)
  await mkdir(scratchDir, { recursive: true })
  const scratchCheck = await checkSandboxPaths(o.cwd, scratchDir)
  if (!scratchCheck.ok) {
    log(`probes: skipped — ${scratchCheck.reason}`)
    return undefined
  }

  // The double-run needs a merge-base checkout. Failures here don't block
  // the lane — head results still record — but without base nothing can
  // upgrade to `reproduced`.
  const wtDir = join(o.reportDir, 'probes-base')
  let baseDir: string | undefined
  if (o.meta?.baseSha !== undefined) {
    baseDir = await addBaseWorktree(exec, o.cwd, wtDir, o.meta.baseSha, o.token)
  }
  if (baseDir === undefined) {
    log('probes: base worktree unavailable — head results will be recorded but cannot reproduce')
  }

  const records: ProbeRecord[] = []
  try {
    for (const target of targets) {
      // Authoring stops at the budget edge but must NOT flag the ledger —
      // `budgetExceeded` flips the review verdict, and KTD8 pins the lane
      // to never change verdict. The spend still records on the ledger.
      if (o.budgetUsd !== undefined && o.ledger.visionCostUsd >= o.budgetUsd) {
        log('probes: authoring budget reached — remaining findings stay not_exercised')
        break
      }
      const authored = await authorProbe(
        o,
        target,
        harness,
        target.file === undefined ? undefined : findExemplarTest(o.index, target.file),
      )
      if (authored.probe === undefined) {
        records.push(record(target, undefined, 'error', `authoring failed: ${authored.reason}`))
        continue
      }
      const probe = authored.probe
      const relProbe =
        target.file === undefined
          ? probe.filename
          : join(
              dirname(findExemplarTest(o.index, target.file) ?? ''),
              probe.filename,
            ).replace(/^\.\//, '')

      // Write on the host — the ro workspace mount exposes it to head, and
      // a copy into the base worktree makes the double-run symmetric.
      try {
        await writeFile(join(o.cwd, relProbe), probe.content, 'utf8')
        if (baseDir !== undefined) {
          await mkdir(dirname(join(baseDir, relProbe)), { recursive: true })
          await writeFile(join(baseDir, relProbe), probe.content, 'utf8')
        }
      } catch (e) {
        records.push(record(target, probe, 'error', `probe write failed: ${(e as Error).message}`))
        continue
      }

      try {
        const head = await runProbeInSandbox({
          workdir: o.cwd,
          scratchDir,
          cmd: harness.runCmd(relProbe),
          image,
          name: `head-${records.length}`,
          exec,
          ...sandboxLimits(sandbox),
        })
        // exitCode -1 is the "never ran" sentinel (path check / spawn
        // rejection) — infra error, not harness output to classify.
        const headOutcome: ProbeOutcome | 'error' =
          head.timedOut || head.exitCode === -1 ? 'error' : harness.classify(head)

        let baseOutcome: ProbeOutcome | 'error' | undefined
        let baseOutput = ''
        if (baseDir !== undefined) {
          const baseScratch = join(baseDir, SCRATCH_DIR_NAME)
          await mkdir(baseScratch, { recursive: true })
          const base = await runProbeInSandbox({
            workdir: baseDir,
            scratchDir: baseScratch,
            cmd: harness.runCmd(relProbe),
            image,
            name: `base-${records.length}`,
            exec,
            ...sandboxLimits(sandbox),
          })
          baseOutcome = base.timedOut || base.exitCode === -1 ? 'error' : harness.classify(base)
          baseOutput = probeOutput(base.stdout, base.stderr) ?? ''
        }

        const output =
          probeOutput(head.stdout, head.stderr) ??
          (baseOutput === '' ? undefined : baseOutput)

        if (headOutcome === 'failed-test' && baseOutcome === 'clean') {
          target.evidence = {
            status: 'reproduced',
            detail: `reproduced by Argus probe ${probe.filename} (fails on head, clean on base)`,
          }
          records.push(
            record(target, probe, 'reproduced', 'probe fails on head and passes on base', {
              headOutcome,
              baseOutcome,
              durationMs: head.durationMs,
              costUsd: authored.costUsd,
              output,
            }),
          )
        } else {
          const outcome: ProbeReportOutcome =
            headOutcome === 'failed-test'
              ? baseOutcome === undefined
                ? 'error'
                : 'load-error' // failed on head but base did not stay clean — probe bug or pre-existing
              : headOutcome
          const detail =
            headOutcome === 'failed-test'
              ? baseOutcome === undefined
                ? 'fails on head but base checkout unavailable — unverified'
                : 'fails on both head and base — probe bug or pre-existing defect'
              : `head outcome: ${headOutcome}`
          records.push(
            record(target, probe, outcome, detail, {
              headOutcome,
              baseOutcome,
              durationMs: head.durationMs,
              costUsd: authored.costUsd,
              output,
            }),
          )
        }
      } finally {
        await rm(join(o.cwd, relProbe), { force: true }).catch(() => undefined)
        if (baseDir !== undefined) {
          await rm(join(baseDir, relProbe), { force: true }).catch(() => undefined)
        }
      }
    }
  } finally {
    if (baseDir !== undefined) await removeBaseWorktree(exec, o.cwd, wtDir)
  }
  return records
}
