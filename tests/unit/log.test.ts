import { describe, expect, it } from 'vitest'

import { createLogger, resolveLogLevel } from '../../src/log.js'

describe('logger', () => {
  it('gates by level', () => {
    const lines: string[] = []
    const log = createLogger('warn', { err: (l) => lines.push(l) })
    log.debug('hidden')
    log.info('hidden')
    log.warn('shown')
    log.error('shown too')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('warn')
  })

  it('ARGUS_DEBUG=1 forces debug regardless of config', () => {
    expect(resolveLogLevel({ ARGUS_DEBUG: '1' }, 'warn')).toBe('debug')
    expect(resolveLogLevel({ ARGUS_DEBUG: 'true' })).toBe('debug')
    expect(resolveLogLevel({}, 'info')).toBe('info')
    expect(resolveLogLevel({}, 'bogus')).toBe('warn')
    expect(resolveLogLevel({})).toBe('warn')
  })
})
