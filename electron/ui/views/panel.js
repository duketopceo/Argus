// One renderer for the panel state diagram (plan U13, R20) so every panel
// treats loading, error, stale, partial and empty the same way.
import { banner, button, loadingRows } from '../dom.js'

export const lastGoodClock = (t) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Fill `box` for `panel`. `ready(box)` draws data; `empty(box)` the empty
 * state; `partial(box)` a source problem (it may call `ready` itself).
 * Stale panels draw their last-good content; the top banner says when it
 * was last good and carries Retry, and each panel's "as of" tag turns caution.
 */
export function renderPanel(box, panel, { label, ready, empty, partial, nokey, retry }) {
  box.replaceChildren()
  box.removeAttribute('aria-busy')
  const status = panel.status === 'stale' ? panel.was : panel.status
  if (status === 'loading') {
    box.setAttribute('aria-busy', 'true')
    box.append(loadingRows(`Loading ${label}`))
    return
  }
  if (status === 'error') {
    box.append(
      banner('failed', `Could not load ${label}.`, {
        body: panel.detail ?? panel.error,
        action: retry ? button('Retry', { icon: 'refresh', onClick: retry }) : undefined,
      }),
    )
    return
  }
  if (status === 'partial' && partial) partial(box)
  else if (status === 'nokey' && nokey) nokey(box)
  else if (status === 'empty' || status === 'nokey') empty(box)
  else ready(box)
}
