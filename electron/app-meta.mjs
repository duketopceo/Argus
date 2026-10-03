// Window title and version for the contributor desk app. Kept out of
// main.mjs so a unit test can import it without loading Electron.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const APP_TITLE = 'Argus'

/** App scheme the desk UI loads from (electron/desk-files.mjs maps paths). */
export const DESK_SCHEME = 'argus'
export const DESK_URL = `${DESK_SCHEME}://desk/index.html`

/** Desk app window and dock icon (DESIGN.md A8), built by `npm run brand`. */
export const APP_ICON = fileURLToPath(
  new URL('../assets/brand/export/icons/app-icon-512.png', import.meta.url),
)

/** The `version` field of the repo's package.json, the single source of truth. */
export function appVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/**
 * Why the run-eval IPC must refuse, or undefined to proceed. Evals spend
 * real OpenRouter credit: the renderer may only start one after the spend
 * confirm, which passes `{ confirmed: true }` (PR #111).
 */
export function evalRefusal(opts, { running, env }) {
  if (opts?.confirmed !== true) return 'Eval not started: it needs to be confirmed first.'
  if (running) return 'An eval is already running.'
  if (!env.OPENROUTER_API_KEY) return 'OPENROUTER_API_KEY is not set. Export it and restart the desk.'
  return undefined
}
