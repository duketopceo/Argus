// Path map for the desk front end (plan KTD9). The UI is static files plus a
// data bridge; whatever serves it (Electron's argus:// protocol today, a
// 127.0.0.1 server later) maps request paths the same way:
//
//   /brand/<rel>   assets/brand/<rel>   tokens, fonts, motion, sprites, art
//   /report/<rel>  <reportDir>/<rel>    flow-lane screenshots (images only)
//   /<rel>         electron/ui/<rel>    the front end itself
//
// Kept free of Electron imports so tests and the QA fixture server share it.
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url))
export const BRAND_DIR = fileURLToPath(new URL('../assets/brand/', import.meta.url))

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const REPORT_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const inside = (base, file) => file.startsWith(base.endsWith(sep) ? base : base + sep)

/**
 * Absolute file for a request path, or undefined when the path is malformed,
 * escapes its root, or names a type the root does not serve. Fails closed.
 */
export function deskFile(pathname, { uiDir = UI_DIR, brandDir = BRAND_DIR, reportDir } = {}) {
  let p
  try {
    p = decodeURIComponent(String(pathname ?? '/').split('?')[0].split('#')[0])
  } catch {
    return undefined
  }
  if (p.includes('\0') || p.includes('\\')) return undefined
  let base
  let rel
  if (p.startsWith('/brand/')) [base, rel] = [brandDir, p.slice('/brand/'.length)]
  else if (p.startsWith('/report/')) {
    if (!reportDir) return undefined
    ;[base, rel] = [reportDir, p.slice('/report/'.length)]
    if (!REPORT_TYPES.has(extname(rel).toLowerCase())) return undefined
  } else [base, rel] = [uiDir, p === '/' ? 'index.html' : p.slice(1)]
  const file = resolve(base, rel)
  if (!inside(resolve(base), file)) return undefined
  if (MIME[extname(file).toLowerCase()] === undefined) return undefined
  return file
}

export const mimeOf = (file) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
