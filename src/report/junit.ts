import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface JunitCase {
  name: string
  className: string | undefined
  durationMs: number
  ok: boolean
  failureMessage: string | undefined
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Render a JUnit XML report: one <testcase> per test with pass/fail + duration. */
export function renderJunitXml(suiteName: string, cases: JunitCase[]): string {
  const failures = cases.filter((c) => !c.ok).length
  const totalSeconds = cases.reduce((sum, c) => sum + c.durationMs, 0) / 1000

  const body = cases
    .map((c) => {
      const attrs = [
        `name="${escapeXml(c.name)}"`,
        `classname="${escapeXml(c.className ?? suiteName)}"`,
        `time="${(c.durationMs / 1000).toFixed(3)}"`,
      ].join(' ')
      if (c.ok) {
        return `    <testcase ${attrs}/>`
      }
      const message = escapeXml(c.failureMessage ?? 'test failed')
      return [
        `    <testcase ${attrs}>`,
        `      <failure message="${message}"/>`,
        `    </testcase>`,
      ].join('\n')
    })
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${cases.length}" failures="${failures}" time="${totalSeconds.toFixed(3)}">`,
    `  <testsuite name="${escapeXml(suiteName)}" tests="${cases.length}" failures="${failures}" time="${totalSeconds.toFixed(3)}">`,
    body,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n')
}

export async function writeJunitXml(
  path: string,
  suiteName: string,
  cases: JunitCase[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, renderJunitXml(suiteName, cases), 'utf8')
}
