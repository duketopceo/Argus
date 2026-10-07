import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { writeAtomicJson } from '../fsutil.js'

export const INDEX_SCHEMA_VERSION = 1

export interface IndexEntry {
  /** Repo-relative path. */
  path: string
  /** Best-effort purpose: first doc comment or leading export names. */
  purpose?: string
  /** Repo-relative paths this file imports (TS/JS only). */
  imports: string[]
  /** Repo-relative paths that import this file — the transitive backstop for diff invalidation. */
  importedBy: string[]
  /** Nearest ancestor package.json version, when present. */
  packageVersion?: string
  /** sha256 of file contents — cheap staleness signal. */
  contentHash: string
}

export interface RepoIndex {
  schemaVersion: typeof INDEX_SCHEMA_VERSION
  generatedAt: string
  root: string
  entries: IndexEntry[]
}

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-e2e-vision',
  '.git',
  'coverage',
  '.vision-e2e-cache',
  '.argus-reviewer-cache',
  'argus-reviewer-report',
  'vision-e2e-report',
  'journal',
])
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const LOCKFILE_RE =
  /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock)$/
const BINARY_RE =
  /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|pdf|zip|gz|tar|wasm|so|dylib|exe|bin)$/i
const MAX_FILES = 50_000

async function walk(
  root: string,
  dir: string,
  out: string[],
  includeDotfile?: (name: string) => boolean,
): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable/missing dirs are skipped, never fatal
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.name.startsWith('.') && e.name !== '.storybook') {
      // Scan mode opts credential-shaped dotfiles back in — dotDIRS stay
      // excluded (descending .git/.ssh would defeat the point).
      if (!(e.isFile() && includeDotfile?.(e.name))) continue
    }
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      await walk(root, p, out, includeDotfile)
    } else if (e.isFile()) {
      if (LOCKFILE_RE.test(e.name) || BINARY_RE.test(e.name)) continue
      out.push(p)
    }
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/** Resolve an import specifier to a repo-relative path when it's local. */
function resolveImport(spec: string, fromFile: string, files: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = resolve(dirname(fromFile), spec)
  const exts = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']
  const candidates = [
    base,
    ...exts.map((e) => `${base}.${e}`),
    ...exts.map((e) => `${base}/index.${e}`),
  ]
  for (const cand of candidates) {
    if (files.has(cand)) return cand
  }
  return undefined
}

/** Memoized per directory — sibling files share the same ancestor walk. */
async function nearestPackageVersion(
  file: string,
  root: string,
  cache: Map<string, Promise<string | undefined>>,
): Promise<string | undefined> {
  const start = dirname(file)
  const cached = cache.get(start)
  if (cached !== undefined) return cached
  const promise = (async (): Promise<string | undefined> => {
    let dir = start
    // Path-boundary containment: `startsWith(root)` alone would accept a
    // sibling like `/repo-extra`; require an exact match or a subpath.
    while (dir === root || dir.startsWith(root + '/')) {
      try {
        const raw = await readFile(join(dir, 'package.json'), 'utf8')
        const parsed = JSON.parse(raw) as { version?: string }
        if (parsed.version) return parsed.version
      } catch {
        // no package.json at this level — keep walking up
      }
      if (dir === root) break
      dir = dirname(dir)
    }
    return undefined
  })()
  cache.set(start, promise)
  return promise
}

function inferPurpose(source: string, isSource: boolean): string | undefined {
  if (!isSource) return undefined
  const doc = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)
  if (doc) {
    const first = (doc[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter(Boolean)[0]
    if (first !== undefined && first !== '') return first.slice(0, 160)
  }
  const exports_ = [
    ...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+(\w+)/g),
  ]
    .map((m) => m[1])
    .slice(0, 4)
  if (exports_.length > 0) return `exports: ${exports_.join(', ')}`
  return undefined
}

export interface SynthesizedDiff {
  diff: string
  /** Files that got a new-file section. */
  filesWritten: number
  /** Files skipped — oversized or unreadable mid-synthesis. */
  filesSkipped: number
}

/** Files above this size are skipped during diff synthesis. */
const SCAN_FILE_CAP_BYTES = 512 * 1024

/** Total synthesized-diff cap — pathological trees degrade to filesSkipped. */
const SCAN_DIFF_CAP_BYTES = 64 * 1024 * 1024

/**
 * POSIX filenames may contain line terminators — interpolating one into a
 * header would split it into injected diff lines (evasion or attribution
 * spoofing through `addedLines`). Git C-quotes these; we skip them.
 */
const UNSAFE_PATH_RE = /[\n\r\u2028\u2029]/

/**
 * U7 — synthesize a unified diff treating every walked file as new
 * (`--- /dev/null` / `+++ b/`), so the deterministic lanes (rules,
 * secrets) can consume a plain tree the way they consume a PR diff.
 * Emitting the diff ourselves means headers are always `b/` and never
 * C-quoted — the ambient-gitconfig evasion class cannot apply.
 */
export async function synthesizeTreeDiff(
  root: string,
  entries: readonly { path: string }[],
): Promise<SynthesizedDiff> {
  const abs = resolve(root)
  const parts: string[] = []
  let filesWritten = 0
  let filesSkipped = 0
  let totalBytes = 0
  const CONCURRENCY = 64
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const results = await Promise.allSettled(
      entries.slice(i, i + CONCURRENCY).map(async (e) => {
        if (UNSAFE_PATH_RE.test(e.path)) return 'skipped' as const
        if (totalBytes > SCAN_DIFF_CAP_BYTES) return 'skipped' as const
        // Stat before read — an oversized file is skipped for a syscall,
        // not buffered whole only to be discarded.
        const st = await stat(join(abs, e.path))
        if (st.size > SCAN_FILE_CAP_BYTES) return 'skipped' as const
        const buf = await readFile(join(abs, e.path))
        const text = buf.toString('utf8')
        const lines = text.split('\n')
        // A trailing newline yields a final empty element — not a line.
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const body = lines.map((l) => `+${l}`).join('\n')
        return (
          `diff --git a/${e.path} b/${e.path}\n` +
          `new file mode 100644\n` +
          `--- /dev/null\n` +
          `+++ b/${e.path}\n` +
          `@@ -0,0 +1,${lines.length} @@\n` +
          body
        )
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'skipped') filesSkipped++
      else if (r.status === 'fulfilled' && typeof r.value === 'string') {
        // Post-check too: the pre-read check races the whole batch, so a
        // section produced past the cap must still be counted skipped.
        if (totalBytes > SCAN_DIFF_CAP_BYTES) {
          filesSkipped++
          continue
        }
        parts.push(r.value)
        filesWritten++
        totalBytes += r.value.length
      } else filesSkipped++
    }
  }
  return { diff: parts.join('\n'), filesWritten, filesSkipped }
}

/** Scan a repo into a RepoIndex. Never throws on individual file failures. */
export async function scanRepo(
  root: string,
  opts: { includeDotfile?: (name: string) => boolean } = {},
): Promise<RepoIndex> {
  const abs = resolve(root)
  const files: string[] = []
  await walk(abs, abs, files, opts.includeDotfile)
  const fileSet = new Set(files)

  const pkgCache = new Map<string, Promise<string | undefined>>()
  // Bounded concurrency — Promise.all over up to 50k files would exhaust
  // file descriptors. Chunks of 64 keep I/O saturated without EMFILE risk.
  const CONCURRENCY = 64
  const sorted = files.sort()
  const entries: IndexEntry[] = []
  for (let i = 0; i < sorted.length; i += CONCURRENCY) {
    const chunk = sorted.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(async (file): Promise<IndexEntry | undefined> => {
        const rel = relative(abs, file)
        let buf: Buffer
        try {
          buf = await readFile(file)
        } catch {
          return undefined // unreadable files are skipped, never fatal
        }
        const isSource = SOURCE_RE.test(file)
        const text = isSource ? buf.toString('utf8') : undefined
        const imports: string[] = []
        if (isSource && text !== undefined) {
          try {
            const info = ts.preProcessFile(text, true, true)
            for (const spec of [
              ...info.importedFiles.map((f) => f.fileName),
              ...info.referencedFiles.map((f) => f.fileName),
            ]) {
              const dep = resolveImport(spec, file, fileSet)
              if (dep !== undefined) imports.push(relative(abs, dep))
            }
          } catch {
            // unparseable file — entry still exists with empty imports
          }
        }
        const purpose = inferPurpose(text?.slice(0, 4000) ?? '', isSource)
        const packageVersion = await nearestPackageVersion(file, abs, pkgCache)
        const entry: IndexEntry = { path: rel, imports, importedBy: [], contentHash: sha256(buf) }
        if (purpose !== undefined) entry.purpose = purpose
        if (packageVersion !== undefined) entry.packageVersion = packageVersion
        return entry
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== undefined) entries.push(r.value)
    }
  }

  // Build reverse edges in a second pass — no shared-map races during the
  // parallel scan.
  const importedBy = new Map<string, string[]>()
  for (const e of entries) {
    for (const dep of e.imports) {
      const list = importedBy.get(dep) ?? []
      list.push(e.path)
      importedBy.set(dep, list)
    }
  }
  for (const e of entries) {
    e.importedBy = (importedBy.get(e.path) ?? []).sort()
    e.imports.sort()
  }

  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: abs,
    entries,
  }
}

export async function writeIndex(index: RepoIndex, outPath: string): Promise<void> {
  await writeAtomicJson(outPath, index)
}

const MAX_INDEX_BYTES = 32 * 1024 * 1024

function isIndexEntry(v: unknown): v is IndexEntry {
  const e = v as IndexEntry
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.path === 'string' &&
    Array.isArray(e.imports) &&
    Array.isArray(e.importedBy) &&
    typeof e.contentHash === 'string'
  )
}

/** Load a previously written index; undefined when absent, oversized, or malformed. */
export async function readIndex(path: string): Promise<RepoIndex | undefined> {
  try {
    const stat = await import('node:fs/promises').then((fs) => fs.stat(path))
    if (stat.size > MAX_INDEX_BYTES) return undefined
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as RepoIndex
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return undefined
    }
    if (!parsed.entries.every(isIndexEntry)) return undefined
    return parsed
  } catch {
    return undefined
  }
}
