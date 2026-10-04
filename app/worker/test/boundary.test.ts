import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppJwt, importPrivateKey } from '../src/auth.js'
import { PRIVATE_KEY } from './fakeGithub.js'

const srcDir = join(import.meta.dirname, '../src')
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, text: readFileSync(join(srcDir, f), 'utf8') }))

describe('R3 boundary (Worker never holds a model key, secrets, or customer code)', () => {
  it('has no OpenRouter binding, secrets API, checkout or process-spawn code', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/env\.OPENROUTER|OPENROUTER_API_KEY\s*\?:/)
      expect(text, f).not.toMatch(/actions\/secrets|\/secrets\/|secrets:\s*write/)
      expect(text, f).not.toMatch(/child_process|node:fs|git\/trees|\/tarball|\/zipball|\/contents\/[^'"`]*\?ref=.*download/)
    }
  })
  it('requests only the four onboarding permissions', async () => {
    const { INSTALLATION_PERMISSIONS } = await import('../src/auth.js')
    expect(Object.keys(INSTALLATION_PERMISSIONS).sort()).toEqual(['contents', 'metadata', 'pull_requests', 'workflows'])
  })
})

describe('Q3: RS256 signing cost', () => {
  it('key import + JWT sign stays far below the 10 ms free-plan CPU limit (generous bound for CI noise)', async () => {
    await createAppJwt('1', await importPrivateKey(PRIVATE_KEY)) // warm
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) await createAppJwt('1', await importPrivateKey(PRIVATE_KEY))
    const per = (performance.now() - t0) / 5
    expect(per).toBeLessThan(50)
  })
})
