// Desk keyboard model (plan U13, R21; DESIGN.md 7.4, 9). Pure: maps a key
// event plus context to an action name. app.js performs the action.
// Tested in tests/unit/desk-keys.test.ts.

/** Every key the desk answers to, in the order the `?` sheet lists them. */
export const KEYMAP = [
  { keys: ['j', 'k'], action: 'next-run', label: 'Next or previous run' },
  { keys: [']', '['], action: 'next-lane', label: 'Next or previous lane' },
  { keys: ['Enter'], action: 'open', label: 'Open the focused run or lane' },
  { keys: ['/'], action: 'filter', label: 'Filter runs' },
  { keys: ['r'], action: 'refresh', label: 'Refresh now' },
  { keys: ['?'], action: 'help', label: 'Show or hide these keys' },
  { keys: ['Esc'], action: 'close', label: 'Close the open sheet or dialog' },
  { keys: ['Tab'], action: 'tab', label: 'Move between panes and controls' },
]

// Pairs share one help row; the reducer still needs both actions.
const ACTIONS = {
  j: 'next-run',
  k: 'prev-run',
  ']': 'next-lane',
  '[': 'prev-lane',
  '/': 'filter',
  '?': 'help',
  r: 'refresh',
  Enter: 'open',
  Escape: 'close',
}
const LISTED = { 'prev-run': 'next-run', 'prev-lane': 'next-lane' }

/**
 * Action for a keydown, or undefined to let the browser have it.
 * ctx.inField: focus is in a text input. ctx.overlay: a sheet or dialog is open.
 */
export function keyAction(e, ctx = {}) {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined
  const action = ACTIONS[e.key]
  if (action === undefined) return undefined
  if (action === 'close') return action
  if (ctx.inField) return undefined
  if (ctx.overlay) return action === 'help' ? action : undefined
  return action
}

/** The help row an action is listed under. */
export const listedAs = (action) => LISTED[action] ?? action
