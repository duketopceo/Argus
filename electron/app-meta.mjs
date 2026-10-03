// Window title and version for the contributor desk app. Kept out of
// main.mjs so a unit test can import it without loading Electron.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const APP_TITLE = 'Argus'

/** Desk app window and dock icon (DESIGN.md A8), built by `npm run brand`. */
export const APP_ICON = fileURLToPath(
  new URL('../assets/brand/export/icons/app-icon-512.png', import.meta.url),
)

/** The `version` field of the repo's package.json, the single source of truth. */
export function appVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}
