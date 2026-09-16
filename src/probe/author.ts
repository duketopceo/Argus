import { posix } from 'node:path'

import ts from 'typescript'
import type { JsonSchema, Message } from '../vision/openrouter.js'
import type { Harness } from './harness.js'

/**
 * Probe authoring (KTD7): one bounded model call per `not_exercised`
 * finding produces a single test file asserting the *correct* behavior —
 * so the defect's presence fails the test on head while the base checkout
 * passes. The file is written on the HOST (inside the ro workspace mount),
 * so `filename` and `content` are validated hard: the model's input includes
 * PR-controlled file contents, and a prompt-injected traversal or secret
 * read would escape the sandbox's whole purpose.
 */

export const PROBE_SCHEMA: JsonSchema = {
  name: 'argus-probe',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Bare test filename matching the repo convention, e.g. probe-xyz.test.ts',
      },
      content: { type: 'string', description: 'Complete test file contents' },
      reasoning: { type: 'string' },
    },
    required: ['filename', 'content', 'reasoning'],
    additionalProperties: false,
  },
}

export interface ProbeTarget {
  file?: string | undefined
  line?: number | undefined
  severity: string
  message: string
}

export interface AuthoredProbe {
  filename: string
  content: string
  reasoning: string
  /** Import specifiers extracted at parse time — checked against the write path in the queue. */
  imports: string[]
}

export type ProbeParseResult = { ok: true; probe: AuthoredProbe } | { ok: false; reason: string }

/**
 * Basename-only, forced test extension — no separators, no `..`. The write
 * happens on the host, so this is the traversal boundary.
 */
export const PROBE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.test\.[jt]sx?$/

/** Probe files are bounded — a runaway generation is rejected, not truncated. */
export const PROBE_CONTENT_CAP = 32 * 1024

/** Reads of secret-looking env vars are forbidden — defense in depth on the stripped container env. */
const SECRET_ENV_RE = /process\.env\s*(?:\.|\[)\s*['"]?\w*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i

/**
 * Import specifiers via the TypeScript scanner (same seam as the index) —
 * a regex misses bare side-effect imports like `import '/abs/x'`. Returns
 * undefined when the scanner itself fails — fail closed, never silently
 * skip the import check.
 */
function importSpecifiers(content: string): string[] | undefined {
  try {
    const info = ts.preProcessFile(content, true, true)
    return [...info.importedFiles, ...info.referencedFiles].map((f) => f.fileName)
  } catch {
    return undefined
  }
}

export function parseProbe(raw: string): ProbeParseResult {
  let parsed: { filename?: unknown; content?: unknown; reasoning?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return { ok: false, reason: 'unparseable model response' }
  }
  if (typeof parsed.filename !== 'string' || !PROBE_FILENAME_RE.test(parsed.filename)) {
    return { ok: false, reason: `unsafe filename: ${String(parsed.filename)}` }
  }
  if (typeof parsed.content !== 'string' || parsed.content.trim() === '') {
    return { ok: false, reason: 'missing or empty content' }
  }
  if (parsed.content.length > PROBE_CONTENT_CAP) {
    return { ok: false, reason: `content exceeds ${PROBE_CONTENT_CAP} bytes` }
  }
  if (SECRET_ENV_RE.test(parsed.content)) {
    return { ok: false, reason: 'probe reads secret-looking env vars' }
  }
  const imports = importSpecifiers(parsed.content)
  if (imports === undefined) {
    return { ok: false, reason: 'probe content failed import scanning' }
  }
  for (const spec of imports) {
    // Reject anything that isn't a bare specifier or plain relative path:
    // absolute paths, drive letters, UNC, and scheme-prefixed specifiers
    // (`file:///etc/passwd` is a host read, `data:` smuggles a module).
    // `node:` builtins stay allowed — node-test probes need `node:test`.
    if (
      spec.startsWith('/') ||
      /^[a-zA-Z]:/.test(spec) ||
      spec.startsWith('\\\\') ||
      (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith('node:'))
    ) {
      return { ok: false, reason: `unsafe import: ${spec}` }
    }
  }
  return {
    ok: true,
    probe: {
      filename: parsed.filename,
      content: parsed.content,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      imports,
    },
  }
}

/**
 * Verify every relative import in a probe resolves inside the repo, given
 * the probe's repo-relative write path. `../../etc/passwd` from a shallow
 * dir escapes the checkout — reject.
 */
export function probeImportsSafe(probe: AuthoredProbe, relProbePath: string): boolean {
  // Repo-relative paths are always `/`-separated — compute in posix so a
  // Windows host can't turn `../x` into `..\x` and slip the `../` check.
  const dir = posix.dirname(relProbePath)
  return probe.imports.every((spec) => {
    if (!spec.startsWith('.')) return true // bare package specifier — resolved from node_modules
    const resolved = posix.normalize(posix.join(dir, spec))
    return resolved !== '..' && !resolved.startsWith('../') && !posix.isAbsolute(resolved)
  })
}

export function buildProbeMessages(
  target: ProbeTarget,
  fileContents: string | undefined,
  exemplarTest: { path: string; content: string } | undefined,
  harness: Harness,
): Message[] {
  const exemplar =
    exemplarTest === undefined
      ? '(no existing test file was available as an exemplar — follow standard idiom)'
      : `Exemplar test file (${exemplarTest.path}) — match its imports, naming, and assertion style:\n\n${exemplarTest.content}`
  const implicated =
    fileContents === undefined
      ? `(file contents unavailable; the finding references ${target.file ?? 'unknown'})`
      : `Contents of ${target.file}:\n\n${fileContents}`
  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text:
            `You author a single failing test — a "probe" — that reproduces a suspected defect ` +
            `found by code review. The probe runs under ${harness.kind} in an offline sandbox. ` +
            `Write a self-contained ${harness.kind} test that asserts the CORRECT behavior: if the ` +
            `defect is real, the test fails; if the code is fine, it passes. Import only repo ` +
            `modules via relative paths and packages the repo already uses. No network, no ` +
            `filesystem outside the repo, no timers, no process.env reads. filename must be a ` +
            `bare filename ending in .test.ts/.test.js matching the exemplar's convention.`,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Finding (${target.severity}) in ${target.file ?? 'unknown'}${target.line ? `:${target.line}` : ''}:\n` +
            `${target.message}\n\n${implicated}\n\n${exemplar}`,
        },
      ],
    },
  ]
}
