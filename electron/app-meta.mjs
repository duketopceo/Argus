// Window title and version for the contributor desk app. Kept out of
// main.mjs so a unit test can import it without loading Electron.
import { readFileSync } from 'node:fs'

export const APP_TITLE = 'Argus'

/** The `version` field of the repo's package.json, the single source of truth. */
export function appVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}
