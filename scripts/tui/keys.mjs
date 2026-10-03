// Key handling for `npm run watch`, as a pure reducer so the spend gate is
// testable without a terminal or a child process. The PR #111 rule holds:
// `e` only opens a confirm showing the plan and estimate; only `y` returns
// the `run-eval` effect.

import { confirmKey } from '../eval-plan.mjs'

const CTRL_C = '\u0003'

/**
 * @param ui   `{ eval, overlay }` from the watch model
 * @param key  raw keypress string from stdin
 * @param deps `{ evalPlan: () => plan }` builds the confirm's plan
 * @returns    `{ ui, effect }` where effect is 'quit' | 'refresh' | 'run-eval' | undefined
 */
export function reduceKey(ui, key, deps) {
  if (key === CTRL_C) return { ui, effect: 'quit' }

  if (ui.overlay === 'help') return { ui: { ...ui, overlay: undefined }, effect: undefined }

  if (ui.eval.confirm !== undefined) {
    if (key === 'q') return { ui, effect: 'quit' }
    const decision = confirmKey(key)
    if (decision === 'ignore') return { ui, effect: undefined }
    const ev = { ...ui.eval, confirm: undefined }
    if (decision === 'confirm') return { ui: { ...ui, eval: { ...ev, note: '' } }, effect: 'run-eval' }
    return { ui: { ...ui, eval: { ...ev, note: 'eval cancelled, nothing was run' } }, effect: undefined }
  }

  if (key === 'q') return { ui, effect: 'quit' }
  if (key === 'r') return { ui, effect: 'refresh' }
  if (key === '?') return { ui: { ...ui, overlay: 'help' }, effect: undefined }
  if (key === 'e') {
    if (ui.eval.running) return { ui, effect: undefined }
    return { ui: { ...ui, eval: { ...ui.eval, confirm: deps.evalPlan(), note: '' } }, effect: undefined }
  }
  return { ui, effect: undefined }
}
