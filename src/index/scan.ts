import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

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
  'node_modules', 'dist', 'dist-e2e-vision', '.git', 'coverage',
  '.vision-e2e-cache', 'journal',
])
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const MAX_FILES = 50_000

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.name.startsWith('.') && e.name !== '.storybook') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      await walk(root, p, out)
    } else if (e.isFile()) {
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
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`]) {
    if (files.has(cand)) return cand
  }
  return undefined
}

async function nearestPackageVersion(file: string, root: string): Promise<string | undefined> {
  let dir = dirname(file)
  while (dir.startsWith(root)) {
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
}

function inferPurpose(source: string, isSource: boolean): string | undefined {
  if (!isSource) return undefined
  const doc = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)
  if (doc) {
    const first = (doc[1] ?? '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean)[0]
    if (first !== undefined && first !== '') return first.slice(0, 160)
  }
  const exports_ = [...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+(\w+)/g)]
    .map((m) => m[1])
    .slice(0, 4)
  if (exports_.length > 0) return `exports: ${exports_.join(', ')}`
  return undefined
}

/** Scan a repo into a RepoIndex. Never throws on individual file failures. */
export async function scanRepo(root: string): Promise<RepoIndex> {
  const abs = resolve(root)
  const files: string[] = []
  await walk(abs, abs, files)
  const fileSet = new Set(files)

  const entries: IndexEntry[] = []
  const importedBy = new Map<string, string[]>()

  for (const file of files.sort()) {
    const rel = relative(abs, file)
    let buf: Buffer
    try {
      buf = await readFile(file)
    } catch {
      continue // unreadable files are skipped, never fatal
    }
    const isSource = SOURCE_RE.test(file)
    const imports: string[] = []
    if (isSource) {
      try {
        const info = ts.preProcessFile(buf.toString('utf8'), true, true)
        for (const spec of [...info.importedFiles.map((f) => f.fileName), ...info.referencedFiles.map((f) => f.fileName)]) {
          const dep = resolveImport(spec, file, fileSet)
          if (dep !== undefined) {
            imports.push(relative(abs, dep))
            const list = importedBy.get(relative(abs, dep)) ?? []
            list.push(rel)
            importedBy.set(relative(abs, dep), list)
          }
        }
      } catch {
        // unparseable file — entry still exists with empty imports
      }
    }
    const source = buf.toString('utf8').slice(0, 4000)
    const purpose = inferPurpose(source, isSource)
    const packageVersion = await nearestPackageVersion(file, abs)
    const entry: IndexEntry = { path: rel, imports, importedBy: [], contentHash: sha256(buf) }
    if (purpose !== undefined) entry.purpose = purpose
    if (packageVersion !== undefined) entry.packageVersion = packageVersion
    entries.push(entry)
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
  await mkdir(dirname(outPath), { recursive: true })
  const tmp = `${outPath}.tmp`
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(tmp, outPath)
}

/** Load a previously written index; undefined when absent or unparseable. */
export async function readIndex(path: string): Promise<RepoIndex | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as RepoIndex
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}
