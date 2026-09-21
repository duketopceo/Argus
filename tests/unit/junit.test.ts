import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { renderJunitXml, writeJunitXml } from '../../src/report/junit.js'

describe('renderJunitXml', () => {
  it('renders one testcase per case with pass/fail counts', () => {
    const xml = renderJunitXml('argus-run', [
      { name: 'login flow', className: 'flows', durationMs: 1500, ok: true, failureMessage: undefined },
      { name: 'checkout', className: undefined, durationMs: 500, ok: false, failureMessage: 'expected cart' },
    ])

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<testsuites tests="2" failures="1" time="2.000">')
    expect(xml).toContain('<testsuite name="argus-run" tests="2" failures="1" time="2.000">')
    expect(xml).toContain('<testcase name="login flow" classname="flows" time="1.500"/>')
    expect(xml).toContain('<failure message="expected cart"/>')
  })

  it('falls back to the suite name when className is undefined', () => {
    const xml = renderJunitXml('suite', [
      { name: 't', className: undefined, durationMs: 0, ok: true, failureMessage: undefined },
    ])
    expect(xml).toContain('classname="suite"')
  })

  it('uses "test failed" when a failure has no message', () => {
    const xml = renderJunitXml('suite', [
      { name: 't', className: undefined, durationMs: 0, ok: false, failureMessage: undefined },
    ])
    expect(xml).toContain('<failure message="test failed"/>')
  })

  it('escapes XML entities in names, classnames, and messages', () => {
    const xml = renderJunitXml('a&b', [
      {
        name: 'x <y> "z" \'w\'',
        className: 'c&d',
        durationMs: 0,
        ok: false,
        failureMessage: 'a < b & c > d',
      },
    ])
    expect(xml).toContain('name="x &lt;y&gt; &quot;z&quot; &apos;w&apos;"')
    expect(xml).toContain('classname="c&amp;d"')
    expect(xml).toContain('<failure message="a &lt; b &amp; c &gt; d"/>')
    expect(xml).toContain('name="a&amp;b"')
    expect(xml).not.toContain('a < b')
  })

  it('renders an empty body for zero cases', () => {
    const xml = renderJunitXml('empty', [])
    expect(xml).toContain('tests="0" failures="0" time="0.000"')
    expect(xml).not.toContain('<testcase')
  })
})

describe('writeJunitXml', () => {
  it('creates missing directories and writes valid content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-junit-'))
    const path = join(dir, 'nested', 'deep', 'report.xml')
    await writeJunitXml(path, 'suite', [
      { name: 't', className: undefined, durationMs: 1, ok: true, failureMessage: undefined },
    ])
    const written = await readFile(path, 'utf8')
    expect(written).toContain('<testsuite name="suite"')
  })
})
