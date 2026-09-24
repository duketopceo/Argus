#!/usr/bin/env node
import { spawn } from 'node:child_process'

function fail(message, code = 2) {
  console.error(`argus action: ${message}`)
  process.exitCode = code
}

let spec
try {
  spec = JSON.parse(process.env.ARGUS_CLI_JSON ?? '')
} catch (error) {
  fail(`invalid CLI bootstrap output: ${error.message}`)
  process.exit()
}

if (!Array.isArray(spec) || spec.length === 0 || typeof spec[0] !== 'string') {
  fail('CLI bootstrap output is not an argv array')
  process.exit()
}

const child = spawn(spec[0], [...spec.slice(1), ...process.argv.slice(2)], {
  cwd: process.env.ARGUS_WORKING_DIRECTORY || process.cwd(),
  env: process.env,
  shell: false,
  stdio: 'inherit',
})

child.on('error', (error) => fail(error.message, 127))
child.on('close', (code, signal) => {
  if (signal) {
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
