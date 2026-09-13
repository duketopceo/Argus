import { describe, expect, it } from 'vitest'

import { a0TaskPrompt, buildA0Args, runA0Task } from '../../src/executor/a0.js'
import type { ExecFn } from '../../src/detect.js'

describe('buildA0Args', () => {
  it('runs one-shot headless against a new chat', () => {
    expect(buildA0Args('do the thing', undefined)).toEqual([
      'headless',
      '--new-chat',
      '--output',
      'text',
      '-p',
      'do the thing',
    ])
  })

  it('passes --host before the prompt when given', () => {
    const args = buildA0Args('task', 'https://a0.example.com')
    expect(args).toContain('--host')
    expect(args).toContain('https://a0.example.com')
    expect(args.at(-2)).toBe('-p')
    expect(args.at(-1)).toBe('task')
  })
})

describe('a0TaskPrompt', () => {
  it('binds the task to the app URL', () => {
    expect(a0TaskPrompt('sign up', 'http://localhost:3000')).toBe(
      'Open http://localhost:3000 in your browser, then do this task: sign up',
    )
  })

  it('returns the task verbatim without a URL', () => {
    expect(a0TaskPrompt('sign up', undefined)).toBe('sign up')
  })
})

describe('runA0Task', () => {
  it('returns the agent output on success', async () => {
    const seen: { cmd?: string; args?: string[]; timeout?: number } = {}
    const exec: ExecFn = async (cmd, args, timeout) => {
      seen.cmd = cmd
      seen.args = args
      seen.timeout = timeout
      return { code: 0, stdout: 'flow completed: signup works\n', stderr: '' }
    }
    const res = await runA0Task('sign up', { host: 'https://a0.example.com', exec })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('flow completed: signup works')
    expect(seen.cmd).toBe('a0')
    expect(seen.args).toContain('https://a0.example.com')
    expect(seen.timeout).toBe(600_000)
  })

  it('surfaces stderr when the CLI fails', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'connection refused' })
    const res = await runA0Task('sign up', { exec })
    expect(res.ok).toBe(false)
    expect(res.output).toBe('connection refused')
  })
})
