import { lstat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const SHELL_META = /[;&|<>`$\\()[\]{}\r\n\0]/

/** Parse the legacy `cli` input as an argv array without invoking a shell. */
export function parseCommand(raw) {
  const input = String(raw ?? '').trim()
  if (input === '') return undefined
  if (SHELL_META.test(input)) {
    throw new Error('cli must be an executable plus arguments; shell operators are not allowed')
  }

  const tokens = []
  let token = ''
  let quote
  let escaped = false
  let tokenStarted = false

  for (const char of input) {
    if (escaped) {
      token += char
      escaped = false
      tokenStarted = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      tokenStarted = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else token += char
      tokenStarted = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
      continue
    }
    token += char
    tokenStarted = true
  }

  if (escaped) throw new Error('cli ends with an incomplete escape')
  if (quote !== undefined) throw new Error('cli has an unterminated quote')
  if (tokenStarted) tokens.push(token)
  if (tokens.length === 0 || tokens[0] === '') throw new Error('cli executable cannot be empty')
  return tokens
}

export function validateVersion(raw) {
  const version = String(raw ?? '').trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`argus-version must be a pinned semver, got: ${version || '<empty>'}`)
  }
  return version
}

export function validateBrowser(raw) {
  const browser = String(raw ?? 'chromium').trim()
  if (!['chromium', 'firefox', 'webkit'].includes(browser)) {
    throw new Error(`browser must be chromium, firefox, or webkit; got: ${browser || '<empty>'}`)
  }
  return browser
}

export function validateBudget(raw, name = 'budget-usd') {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

export function validateMaxComments(raw) {
  if (raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new Error('max-comments must be a non-negative integer')
  }
  return Number(raw)
}

export function resolveWorkingDirectory(workspace, input) {
  const root = resolve(workspace)
  const requested = String(input ?? '').trim()
  const cwd = requested === '' ? root : resolve(root, requested)
  const rel = relative(root, cwd)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('working-directory must stay inside GITHUB_WORKSPACE')
  }
  return cwd
}

export function validatePathInput(raw, name) {
  const value = String(raw ?? '')
  if (value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`${name} contains an invalid control character`)
  }
  return value
}

export function assertRegularFileInside(root, file, name) {
  const rootPath = resolve(root)
  const filePath = resolve(root, file)
  const rel = relative(rootPath, filePath)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${name} must stay inside the working directory`)
  }
  return filePath
}

export async function assertRegularFile(path, name) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${name} must be a regular non-symlink file: ${path}`)
  }
  return path
}

export function setActionOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT
  const line = `${name}=${String(value).replace(/[\r\n]/g, '')}`
  if (output === undefined || output === '') {
    console.log(line)
    return
  }
  // GITHUB_OUTPUT is supplied by the Actions runner. This synchronous append
  // keeps bootstrap deterministic before the next composite step starts.
  appendFileSync(output, `${line}\n`, 'utf8')
}
