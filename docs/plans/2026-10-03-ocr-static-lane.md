# OCR Static Lane for Argus — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add an optional deterministic static-analysis lane to Argus that runs Alibaba's OpenCodeReview (`ocr`) as an independent second opinion, and unions its findings into the review as a `static` category — without ever letting it weaken the existing additive-only safety guarantees.

**Architecture:** `ocr` runs as an out-of-process CLI over the merge-base diff and emits JSON; Argus shells out through the existing `ExecFn` seam (same pattern as `scanSecrets`/`defaultExec`), maps the JSON onto `AdjudicableFinding`, and hands it to `adjudicateFindings` for Jev adjudication. Deterministic-rule findings enter the same union as model synthesis, so they cannot be erased by prompt injection. `ocr` is a static binary dep discovered at runtime — never required, never auto-installed, and a missing binary degrades to "lane skipped", not to failure.

**Tech Stack:** TypeScript, vitest, `node:child_process` `execFile` via the existing `ExecFn` seam, `@alibaba-group/open-code-review` (Apache-2.0, optional).

---

## Non-negotiables (read before touching code)

These come from Argus's existing design and are not negotiable for this feature.

1. **Additive-only.** Static findings union in *after* model synthesis. A prompt-injected synthesis must never be able to remove them. Mirror the contract documented at `src/review/secrets.ts:1-19`.
2. **Degrade, never fail.** Missing `ocr` binary, OCR crash, OCR timeout, malformed JSON — all produce `staticSkipped` with a reason. They never fail the PR review and never produce a silent empty result.
3. **No new secrets paths.** `ocr` output crosses to Jev inside `state` only, never into findings/comments/report/logs. Raw literals never appear in Argus output — this is the existing masking contract.
4. **Nothing mandatory.** Zero new required deps. Argus must run identically for a user who has never heard of OCR.
5. **Opt-in by default-off.** Enabled via config, not implicit.

---

## Task 1: Define the config surface

**Objective:** Add a typed, default-off config block for the static lane.

**Files:**
- Modify: `src/config.ts` (add `staticLane` interface + default)
- Test: `tests/unit/static-lane-config.test.ts`

**Step 1: Write failing test**

```ts
// tests/unit/static-lane-config.test.ts
import { describe, expect, it } from 'vitest'
import { resolveStaticLaneConfig } from '../../src/review/static.js'

describe('static lane config', () => {
  it('defaults to disabled so nothing changes for existing users', () => {
    const c = resolveStaticLaneConfig()
    expect(c.enabled).toBe(false)
  })

  it('defaults to a generous timeout — ocr on a large changeset is slow', () => {
    expect(resolveStaticLaneConfig().timeoutMs).toBe(180_000)
  })

  it('accepts an explicit binary path', () => {
    const c = resolveStaticLaneConfig({ enabled: true, bin: '/opt/ocr' })
    expect(c.bin).toBe('/opt/ocr')
    expect(c.enabled).toBe(true)
  })

  it('rejects a negative timeout rather than silently defaulting', () => {
    expect(() => resolveStaticLaneConfig({ timeoutMs: -1 })).toThrow()
  })
})
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/unit/static-lane-config.test.ts`
Expected: FAIL — `resolveStaticLaneConfig` not exported from `../../src/review/static.js`

**Step 3: Write minimal implementation**

```ts
// src/review/static.ts — top of file
export interface StaticLaneConfig {
  enabled: boolean
  /** Resolved from PATH unless explicitly set. Never auto-installed. */
  bin: string
  timeoutMs: number
  /** Pass-through for ocr's own model config; empty means "ocr default". */
  model?: string
}

const DEFAULTS: StaticLaneConfig = {
  enabled: false,
  bin: 'ocr',
  timeoutMs: 180_000,
}

export function resolveStaticLaneConfig(
  raw: Partial<StaticLaneConfig> = {},
): StaticLaneConfig {
  if (raw.timeoutMs !== undefined && raw.timeoutMs < 0) {
    throw new Error('staticLane.timeoutMs must be >= 0')
  }
  return { ...DEFAULTS, ...raw }
}
```

**Step 4: Run test to verify pass**

Run: `npx vitest run tests/unit/static-lane-config.test.ts`
Expected: PASS — 4 tests

**Step 5: Commit**

```bash
git add src/review/static.ts tests/unit/static-lane-config.test.ts
git commit -m "feat(static): add default-off static lane config"
```

---

## Task 2: Discover the `ocr` binary without failing when absent

**Objective:** Resolve the binary path, and distinguish "not installed" from "broken" — because those need different `staticSkipped` reasons.

**Files:**
- Modify: `src/review/static.ts`
- Test: `tests/unit/static-lane-discover.test.ts`

**Step 1: Write failing test**

```ts
// tests/unit/static-lane-discover.test.ts
import { describe, expect, it } from 'vitest'
import { discoverOcr } from '../../src/review/static.js'
import type { ExecFn } from '../../src/detect.js'

const notFound: ExecFn = async () => ({ stdout: '', stderr: '', code: 127 })

describe('ocr discovery', () => {
  it('reports not-installed (not an error) when the binary is absent', async () => {
    const r = await discoverOcr('ocr', notFound)
    expect(r.found).toBe(false)
    expect(r.reason).toBe('not-installed')
  })

  it('reports found when --version succeeds', async () => {
    const ok: ExecFn = async () => ({ stdout: 'ocr 1.2.3', stderr: '', code: 0 })
    const r = await discoverOcr('ocr', ok)
    expect(r.found).toBe(true)
  })

  it('distinguishes a crash from absence via the reason field', async () => {
    const crash: ExecFn = async () => ({ stdout: '', stderr: 'panic', code: 2 })
    const r = await discoverOcr('ocr', crash)
    expect(r.found).toBe(false)
    expect(r.reason).toBe('crashed')
  })
})
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/unit/static-lane-discover.test.ts`
Expected: FAIL — `discoverOcr` not exported

**Step 3: Write minimal implementation**

```ts
// src/review/static.ts — append
export interface OcrDiscovery {
  found: boolean
  /** '' | 'not-installed' | 'crashed' */
  reason: string
  version?: string
}

export async function discoverOcr(
  bin: string,
  exec: ExecFn,
): Promise<OcrDiscovery> {
  const r = await exec(bin, ['--version'], 10_000)
  if (r.code === 0) return { found: true, reason: '', version: r.stdout.trim() }
  // 127/ENOENT means the binary simply isn't installed — expected, not a bug.
  // defaultExec resolves ENOENT to code 1, so match both the shell-style 127
  // and an ENOENT message on stderr.
  if (r.code === 127 || /ENOENT/i.test(r.stderr)) return { found: false, reason: 'not-installed' }
  return { found: false, reason: 'crashed' }
}
```

**Step 4: Run test to verify pass**

Run: `npx vitest run tests/unit/static-lane-discover.test.ts`
Expected: PASS — 3 tests

**Step 5: Commit**

```bash
git add src/review/static.ts tests/unit/static-lane-discover.test.ts
git commit -m "feat(static): distinguish ocr absence from crash"
```

---

## Task 3: Map `ocr --format json` output onto `AdjudicableFinding`

**Objective:** Parse OCR's JSON defensively. OCR is a third-party binary whose schema may drift; a schema change must degrade, never crash the review.

**Files:**
- Modify: `src/review/static.ts`
- Test: `tests/unit/static-lane-parse.test.ts`

**Step 1: Write failing test**

```ts
// tests/unit/static-lane-parse.test.ts
import { describe, expect, it } from 'vitest'
import { parseOcrFindings } from '../../src/review/static.js'

describe('ocr output parsing', () => {
  it('maps a well-formed finding onto AdjudicableFinding', () => {
    // The real ocr CLI emits path/content/start_line — see its cli-reference.
    const out = parseOcrFindings(JSON.stringify({
      comments: [{ path: 'src/a.ts', start_line: 12,
        content: 'SQL injection via string concat' }],
    }))
    expect(out.skipped).toBe(false)
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]).toMatchObject({
      file: 'src/a.ts', line: 12,
      message: 'SQL injection via string concat',
    })
    expect(out.findings[0].source).toBe('static')
  })

  it('reports the documented skipped status instead of a clean run', () => {
    const out = parseOcrFindings(JSON.stringify({ status: 'skipped', comments: [] }))
    expect(out.skipped).toBe(true)
    expect(out.reason).toBe('ocr-skipped')
  })

  it('degrades (not throws) on malformed JSON', () => {
    const out = parseOcrFindings('{not json')
    expect(out.skipped).toBe(true)
    expect(out.findings).toEqual([])
    expect(out.reason).toBe('bad-json')
  })

  it('degrades on a schema change instead of crashing', () => {
    const out = parseOcrFindings(JSON.stringify({ totallyDifferent: [] }))
    expect(out.skipped).toBe(true)
    expect(out.reason).toBe('schema-drift')
  })

  it('drops a finding with no file rather than emitting a broken one', () => {
    const out = parseOcrFindings(JSON.stringify({
      comments: [{ line: 3, severity: 'low', message: 'no file' }],
    }))
    expect(out.findings).toEqual([])
  })
})
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/unit/static-lane-parse.test.ts`
Expected: FAIL — `parseOcrFindings` not exported

**Step 3: Write minimal implementation**

```ts
// src/review/static.ts — append
import type { AdjudicableFinding } from './adjudicate.js'

export type StaticFinding = AdjudicableFinding & { source: 'static' }

export interface ParsedOcr {
  findings: StaticFinding[]
  skipped: boolean
  reason?: string
}

export function parseOcrFindings(stdout: string): ParsedOcr {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return { findings: [], skipped: true, reason: 'bad-json' }
  }
  // The CLI can decline a run entirely — that is a skip, not a clean pass.
  if ((raw as { status?: unknown })?.status === 'skipped') {
    return { findings: [], skipped: true, reason: 'ocr-skipped' }
  }
  const comments = (raw as { comments?: unknown })?.comments
  if (!Array.isArray(comments)) {
    // Third-party schema drifted — degrade, don't guess at field names.
    return { findings: [], skipped: true, reason: 'schema-drift' }
  }
  const findings: StaticFinding[] = []
  for (const c of comments as Record<string, unknown>[]) {
    // ocr emits path/content/start_line (cli-reference), not file/message/line.
    const file = typeof c?.path === 'string' ? c.path : ''
    if (!file) continue                       // unusable row, drop it
    findings.push({
      file,
      line: typeof c.start_line === 'number' ? c.start_line : undefined,
      severity: typeof c.severity === 'string' ? c.severity : 'q',
      category: 'security',
      // content can carry raw diff text — including secrets the diff touched —
      // so it goes through the same masking the secrets lane applies to
      // finding messages (see maskFindingMessage in src/review/secrets.ts).
      message: maskSecretLiterals(typeof c.content === 'string' ? c.content.slice(0, 300) : ''),
      source: 'static',
    })
  }
  return { findings, skipped: false }
}
```

**Step 4: Run test to verify pass**

Run: `npx vitest run tests/unit/static-lane-parse.test.ts`
Expected: PASS — 4 tests

**Step 5: Commit**

```bash
git add src/review/static.ts tests/unit/static-lane-parse.test.ts
git commit -m "feat(static): parse ocr json defensively into findings"
```

---

## Task 4: Run the lane end to end (exec seam + skip reasons)

**Objective:** One function that discovers, invokes, parses, and never throws.

**Files:**
- Modify: `src/review/static.ts`
- Test: `tests/unit/static-lane-run.test.ts`

**Step 1: Write failing test**

```ts
// tests/unit/static-lane-run.test.ts
import { describe, expect, it } from 'vitest'
import { runStaticLane } from '../../src/review/static.js'
import type { ExecFn } from '../../src/detect.js'

const cfg = { enabled: true, bin: 'ocr', timeoutMs: 5000 }

describe('runStaticLane', () => {
  it('is a no-op when disabled — the default path', async () => {
    const exec = async () => { throw new Error('must not exec') }
    const r = await runStaticLane({ ...cfg, enabled: false }, exec)
    expect(r.findings).toEqual([])
    expect(r.reason).toBe('disabled')
  })

  it('returns findings on success', async () => {
    const exec: ExecFn = async (_c, a) =>
      a[0] === '--version'
        ? { stdout: 'ocr 1.2.3', stderr: '', code: 0 }
        : { stdout: JSON.stringify({ comments: [
            { file: 'src/a.ts', line: 4, severity: 'high',
              category: 'security', message: 'eval on user input' }] }),
            stderr: '', code: 0 }
    const r = await runStaticLane(cfg, exec)
    expect(r.skipped).toBe(false)
    expect(r.findings).toHaveLength(1)
  })

  it('degrades to a reason on timeout, never throws', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'timeout', code: 124 })
    const r = await runStaticLane(cfg, exec)
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('crashed')
    expect(r.findings).toEqual([])
  })

  it('skips cleanly when ocr is not installed', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', code: 127 })
    const r = await runStaticLane(cfg, exec)
    expect(r.reason).toBe('not-installed')
  })
})
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/unit/static-lane-run.test.ts`
Expected: FAIL — `runStaticLane` not exported

**Step 3: Write minimal implementation**

```ts
// src/review/static.ts — append
export interface StaticLaneResult {
  findings: StaticFinding[]
  skipped: boolean
  reason?: string
  version?: string
}

export async function runStaticLane(
  cfg: StaticLaneConfig,
  exec: ExecFn,
  baseSha: string,
  headSha: string,
): Promise<StaticLaneResult> {
  if (!cfg.enabled) {
    return { findings: [], skipped: true, reason: 'disabled' }
  }
  const d = await discoverOcr(cfg.bin, exec)
  if (!d.found) {
    return { findings: [], skipped: true, reason: d.reason }
  }
  // Range flags are required: without --from/--to the CLI reviews staged,
  // unstaged and untracked workspace changes, and a clean CI checkout
  // produces no PR findings. The smoke test uses the same base/head pair.
  const args = [
    'review', '--format', 'json', '--output', '-',
    '--from', baseSha, '--to', headSha,
  ]
  if (cfg.model) args.push('--model', cfg.model)
  // Third-party binary reading hostile diff content: scrub the environment
  // the same way the probe sandbox does — no *_KEY / *_TOKEN / *_SECRET vars.
  const r = await exec(cfg.bin, args, cfg.timeoutMs, { env: sanitizedExecEnv() })
  if (r.code !== 0) {
    return { findings: [], skipped: true, reason: 'crashed', version: d.version }
  }
  const parsed = parseOcrFindings(r.stdout)
  return {
    findings: parsed.findings,
    skipped: parsed.skipped,
    reason: parsed.reason,
    version: d.version,
  }
}
```

**Step 4: Run test to verify pass**

Run: `npx vitest run tests/unit/static-lane-run.test.ts`
Expected: PASS — 4 tests

**Step 5: Commit**

```bash
git add src/review/static.ts tests/unit/static-lane-run.test.ts
git commit -m "feat(static): run ocr lane with skip reasons, never throwing"
```

---

## Task 5: Additive-only union into the review

**Objective:** Wire static findings into the review so they cannot be erased by model synthesis. This is the task that carries the actual safety guarantee — do it last, and test it hardest.

**Files:**
- Modify: the review orchestration path that unions `scanSecrets` findings (locate with `grep -rn "scanSecrets" src/`)
- Test: `tests/unit/static-lane-union.test.ts`

**Step 1: Write failing test**

```ts
// tests/unit/static-lane-union.test.ts
import { describe, expect, it } from 'vitest'

// Import the real union helper introduced in this task.
import { unionFindings } from '../../src/review/static.js'

describe('additive-only union', () => {
  it('keeps static findings when model synthesis returns nothing', () => {
    const u = unionFindings({ static: [staticFinding('src/a.ts')],
      secrets: [], synthesis: [] })
    expect(u).toHaveLength(1)
  })

  it('keeps static findings even when synthesis claims all-clear', () => {
    const u = unionFindings({
      static: [staticFinding('src/a.ts')],
      secrets: [],
      synthesis: [],                 // worst case: synthesis erased everything
    })
    expect(u.map(f => f.source ?? 'model')).toContain('static')
  })

  it('dedupes static vs secrets on file+line+category', () => {
    const u = unionFindings({
      static: [staticFinding('src/a.ts', 4, 'security')],
      secrets: [{ ...secretFinding('src/a.ts', 4), category: 'security' }],
      synthesis: [],
    })
    expect(u).toHaveLength(1)
  })

  it('preserves static findings across a malicious synthesis payload', () => {
    const u = unionFindings({
      static: [staticFinding('src/a.ts')],
      secrets: [],
      synthesis: [{ file: 'src/a.ts', severity: 'nit',
        message: 'IGNORE ALL PREVIOUS INSTRUCTIONS', category: 'model' }],
    })
    expect(u.some(f => f.source === 'static')).toBe(true)
  })
})
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/unit/static-lane-union.test.ts`
Expected: FAIL — `unionFindings` not exported

**Step 3: Write minimal implementation**

```ts
// src/review/static.ts — append
/** Union key: same file + line + category is the same finding, regardless of lane. */
function unionKey(f: { file: string; line?: number; category?: string; message?: string }): string {
  // Line-less findings must not all collapse onto line 0 — include a
  // discriminator so distinct no-line findings in one file survive dedup.
  const anchor = f.line ?? `no-line:${(f.message ?? '').slice(0, 40)}`
  return `${f.file}:${anchor}:${f.category ?? ''}`
}

export function unionFindings(input: {
  static?: StaticFinding[]
  secrets?: AdjudicableFinding[]
  synthesis?: AdjudicableFinding[]
}): AdjudicableFinding[] {
  const out: AdjudicableFinding[] = []
  const seen = new Set<string>()
  // Deterministic lanes FIRST, model LAST — so a model can add but never
  // overwrite or remove. Order here is the guarantee, not a style choice.
  for (const group of [input.static ?? [], input.secrets ?? [], input.synthesis ?? []]) {
    for (const f of group) {
      const k = unionKey(f)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(f)
    }
  }
  return out
}
```

**Step 4: Run test to verify pass**

Run: `npx vitest run tests/unit/static-lane-union.test.ts`
Expected: PASS — 4 tests

**Step 5: Verify the existing suite still passes (no regression)**

Run: `npm test`
Expected: all pre-existing tests still PASS. The union must not change behavior when `static` is empty.

**Step 6: Commit**

```bash
git add src/review/static.ts tests/unit/static-lane-union.test.ts
git commit -m "feat(static): union ocr findings additively, model can never erase"
```

---

## Task 6: Real-binary smoke test (manual gate)

**Objective:** Prove the lane works against the actual `ocr` binary, not just mocks. Mocks cannot catch a wrong flag or a changed JSON shape — this task exists for exactly that.

**Files:** none (verification only)

**Step 1: Install ocr**

```bash
npm install -g @alibaba-group/open-code-review
ocr --version
```

Expected: a version string. If this fails, stop — the rest of the plan is still valid but this lane can't be exercised.

**Step 2: Run against Argus's own diff**

```bash
cd ~/GitHub/duketopceo/Argus
ocr review --format json --output - > /tmp/ocr.json; echo "exit=$?"
head -c 600 /tmp/ocr.json
```

Expected: valid JSON with a `comments` array. **Record the real shape.** If it differs from `parseOcrFindings`'s expectation, fix the parser and add a fixture from the real output.

**Step 3: Capture a fixture and add it to the parser test**

```bash
cp /tmp/ocr.json tests/fixtures/ocr-review.json
```

Then add to `tests/unit/static-lane-parse.test.ts`:

```ts
import fixture from '../fixtures/ocr-review.json'
it('parses real ocr output without degrading', () => {
  const out = parseOcrFindings(JSON.stringify(fixture))
  expect(out.skipped).toBe(false)
})
```

**Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including the new fixture test.

**Step 5: Commit**

```bash
git add tests/fixtures/ocr-review.json tests/unit/static-lane-parse.test.ts
git commit -m "test(static): pin real ocr json shape as fixture"
```

---

## Task 7: Docs

**Objective:** Document the lane honestly, including its limits.

**Files:**
- Modify: `README.md` (a short "Static analysis lane (optional)" section)
- Modify: `docs/` if a config reference exists

**Content to write — include the honest caveats:**

- Off by default; requires `npm i -g @alibaba-group/open-code-review`
- Adds latency (OCR runs a model) — measure before enabling in CI
- **Lower recall than a general agent by design.** OCR trades recall for precision, so enabling this can *reduce* total findings in some cases. That is not a bug.
- Findings are deterministic-rule based; they complement E2E, they don't replace it

**Step 1: Commit**

```bash
git add README.md docs/
git commit -m "docs: document the optional ocr static lane and its tradeoffs"
```

---

## Definition of done

- [ ] All new unit tests pass; full `npm test` green with no regressions
- [ ] Static lane is **off by default** and existing behavior is byte-identical when off
- [ ] Missing `ocr` → `skipped: 'not-installed'`, review still succeeds
- [ ] Malformed / drifted `ocr` JSON → `skipped`, review still succeeds
- [ ] Model synthesis erasing everything still leaves static findings present
- [ ] Real `ocr` binary exercised end to end (Task 6), fixture committed
- [ ] No raw secret literal reachable from static findings, comments, report, or logs
- [ ] `lint`, `typecheck`, `build` all pass

## Kill criteria — stop and reconsider if

- Real `ocr` JSON shape can't be mapped to `AdjudicableFinding` without guessing
- The lane adds more than ~30s to a typical review
- It turns out OCR's rules duplicate what Argus's existing `scanSecrets` already catches, with no additional coverage

If any kill criterion trips, the correct outcome is to close the PR and note the finding — not to ship a weak integration. Argus's E2E lane is the product; this is an optional second opinion on one axis.
