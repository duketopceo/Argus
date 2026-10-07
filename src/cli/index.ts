import { scanRepo, writeIndex } from '../index/scan.js'
import { type Ctx, resolveCheckoutTrust, loadCliConfig } from './shared.js'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'


/** `argus index` — scan a repo into argus.index.json. */
export async function cmdIndex(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    ctx.out(
      'Usage: argus index [--dir <repo>] [--out <path>]\n\n  Scans the repo into argus.index.json: file → purpose → imports → importedBy → package version → content hash. Consumed by `argus run` for diff-aware cache invalidation.',
    )
    return 0
  }
  const root = resolve(ctx.cwd, values.dir ?? '.')
  const { trust } = await resolveCheckoutTrust(ctx)
  const config = await loadCliConfig(ctx, trust)
  const outPath = resolve(ctx.cwd, values.out ?? config.indexPath ?? 'argus.index.json')
  try {
    const index = await scanRepo(root)
    await writeIndex(index, outPath)
    ctx.out(`indexed ${index.entries.length} files → ${outPath}`)
  } catch (e) {
    // Index failure must never abort a run — degrade to hash verification.
    ctx.err(`argus index failed (continuing without it): ${(e as Error).message}`)
  }
  return 0
}
