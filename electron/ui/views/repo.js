// Repo view (DESIGN.md 7.4): the maintainer panels. Pull requests and
// workflow runs come from `gh`, whose missing or signed-out state is its own
// panel state, never an empty list. Evals render as real tables.
import { banner, button, el, emptyState, statusTag, table, use, CHROME } from '../dom.js'
import { parseEvalDoc, usd6 } from '../model.js'
import { ageSpan } from './runs.js'
import { renderPanel } from './panel.js'

const GH_STATE = {
  'gh-missing': {
    title: 'GitHub CLI not found',
    body: 'Install gh from cli.github.com, sign in, then refresh.',
    command: 'gh auth login',
  },
  'gh-auth': {
    title: 'GitHub CLI is not signed in',
    body: 'Sign in so the desk can list pull requests and workflow runs.',
    command: 'gh auth login',
  },
}

function ghPartial(panel) {
  return (b) => {
    const s = GH_STATE[panel.reason] ?? GH_STATE['gh-missing']
    b.append(banner('caution', s.title, { body: s.body, command: s.command }))
  }
}

const CHECK_STATUS = { pass: 'passed', fail: 'failed', pending: 'running', skipping: 'skipped', cancel: 'skipped' }

export function workflowStatus(r) {
  if (r.status === 'in_progress' || r.status === 'queued') return 'running'
  if (r.conclusion === 'success') return 'passed'
  if (r.conclusion === 'failure') return 'failed'
  if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') return 'skipped'
  return 'unavailable'
}

export function renderPrs(box, ctx) {
  const { panel, state } = ctx
  renderPanel(box, panel, {
    label: 'pull requests',
    retry: ctx.retry,
    partial: ghPartial(panel),
    empty: (b) => b.append(el('p', 'muted pad', 'No open PRs.')),
    ready: (b) => {
      const list = el('ul', 'plain-list')
      for (const p of state.prs ?? []) {
        const li = el('li', 'pr')
        const top = el('div', 'rowline')
        top.append(el('span', 'data num-id', `#${p.number}`), el('span', 'title', p.title))
        const meta = el('div', 'meta')
        const decision =
          p.reviewDecision === 'APPROVED'
            ? el('span', 'tone-passed', 'approved')
            : p.reviewDecision === 'CHANGES_REQUESTED'
              ? el('span', 'tone-failed', 'changes requested')
              : el('span', '', String(p.mergeStateStatus ?? '').toLowerCase())
        meta.append(el('span', 'data', p.headRefName ?? ''), decision)
        li.append(top, meta)
        const checks = (state.prChecks?.[p.number] ?? []).slice(0, 6)
        if (checks.length) {
          const cl = el('ul', 'checks')
          for (const ck of checks) {
            const c = el('li')
            c.append(statusTag(CHECK_STATUS[ck.bucket] ?? 'unavailable', 'compact'), el('span', 'title', ck.name))
            cl.append(c)
          }
          li.append(cl)
        }
        list.append(li)
      }
      b.append(list)
    },
  })
}

export function renderWorkflows(box, ctx) {
  const { panel, state, now } = ctx
  renderPanel(box, panel, {
    label: 'workflow runs',
    retry: ctx.retry,
    partial: ghPartial(panel),
    empty: (b) => b.append(el('p', 'muted pad', 'No workflow runs.')),
    ready: (b) => {
      const list = el('ul', 'plain-list')
      for (const r of state.runs ?? []) {
        const li = el('li', 'wf')
        const st = workflowStatus(r)
        if (st === 'running') li.setAttribute('aria-busy', 'true')
        const top = el('div', 'rowline')
        top.append(statusTag(st), el('span', 'title', r.displayTitle))
        const meta = el('div', 'meta')
        meta.append(el('span', '', r.workflowName ?? ''), el('span', 'data', r.headBranch ?? ''), ageSpan(r.createdAt, now))
        li.append(top, meta)
        if (r.databaseId) {
          const logs = button('Logs', {
            cls: 'btn ghost small',
            icon: 'terminal',
            title: 'Stream this run log into the live log drawer',
            onClick: () => ctx.runLogs(r.databaseId),
          })
          logs.setAttribute('aria-label', `Logs for ${r.displayTitle}`)
          li.append(logs)
        }
        list.append(li)
      }
      b.append(list)
    },
  })
}

function evalDoc(b, md) {
  for (const block of parseEvalDoc(md)) {
    if (block.type === 'heading') b.append(el(block.level <= 1 ? 'h4' : 'h5', 'doc-h', block.text))
    else if (block.type === 'text') b.append(el('p', 'doc-p', block.text))
    else if (block.type === 'list') {
      const ul = el('ul', 'doc-list')
      for (const it of block.items) ul.append(el('li', '', it))
      b.append(ul)
    } else if (block.type === 'table') {
      const numeric = block.head.map((h, i) => (/pass|calls|cost|events/i.test(h) ? i : -1)).filter((i) => i >= 0)
      b.append(table(block.head, block.rows, { numeric, caption: 'Eval results' }))
    }
  }
}

/** Eval run status: running, or the failed exit with Retry reopening the confirm. */
export function renderEvalStatus(box, ev, onRetry) {
  box.replaceChildren()
  const panel = box.closest('.panel')
  if (ev.running) {
    panel?.setAttribute('aria-busy', 'true')
    const row = el('div', 'evalrun')
    row.append(statusTag('running'), el('span', 'dim', 'eval in progress. Output streams below.'))
    box.append(row)
    return
  }
  panel?.removeAttribute('aria-busy')
  if (ev.failed) {
    box.append(
      banner('failed', ev.exit !== undefined ? `Eval exited with code ${ev.exit}.` : 'Eval did not start.', {
        body: ev.lastErr || ev.note || '',
        action: button('Retry', { icon: 'refresh', onClick: onRetry }),
      }),
    )
  }
}

export function renderEvals(box, ctx) {
  const { panel, state } = ctx
  const runEval = () =>
    button('Run eval', { cls: 'btn secondary', icon: 'play', onClick: ctx.openEvalConfirm, title: 'Asks first: shows the estimate and the cap' })
  renderPanel(box, panel, {
    label: 'evals',
    retry: ctx.retry,
    empty: (b) =>
      b.append(
        emptyState({
          title: 'No eval results yet',
          body: 'Evals run the suite against each model and write docs/evals/<date>.md. They spend real OpenRouter credit, so the desk asks first.',
          action: runEval(),
        }),
      ),
    nokey: (b) =>
      b.append(
        emptyState({
          art: 'no-key',
          title: 'No OpenRouter key set',
          body: 'Evals call vision models. Export a key, then restart the desk.',
          command: { text: 'export OPENROUTER_API_KEY=…', copy: 'export OPENROUTER_API_KEY=' },
        }),
      ),
    ready: (b) => evalDoc(b, state.evalDoc),
  })
}

/** DPR-aware cost sparkline in token colors; failed runs get a hollow mark. */
export function sparkline(canvas, journals) {
  const css = getComputedStyle(document.documentElement)
  const color = (name) => css.getPropertyValue(`--argus-color-${name}`).trim() || '#888'
  const w = canvas.clientWidth || 320
  const h = 56
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const costs = journals.map((j) => j.costUsd || 0)
  const max = Math.max(...costs, 1e-6)
  const step = (w - 12) / Math.max(costs.length - 1, 1)
  const pt = (c, i) => [6 + i * step, h - 8 - (c / max) * (h - 16)]
  ctx.strokeStyle = color('hairline')
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h - 8.5)
  ctx.lineTo(w, h - 8.5)
  ctx.stroke()
  ctx.strokeStyle = color('accent')
  ctx.lineWidth = 1.5
  ctx.beginPath()
  costs.forEach((c, i) => {
    const [x, y] = pt(c, i)
    if (i) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
  })
  ctx.stroke()
  costs.forEach((c, i) => {
    const [x, y] = pt(c, i)
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    if (journals[i].ok) {
      ctx.fillStyle = color('passed')
      ctx.fill()
    } else {
      ctx.fillStyle = color('surface')
      ctx.fill()
      ctx.strokeStyle = color('failed')
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  })
  const fails = journals.filter((j) => !j.ok).length
  canvas.setAttribute(
    'aria-label',
    `Cost per journal run, ${journals.length} runs, highest ${usd6(max)}, ${fails} failed (hollow marks).`,
  )
}

export function renderJournals(box, ctx) {
  const { state } = ctx
  box.replaceChildren()
  const js = state?.journals ?? []
  if (!js.length) {
    box.append(el('p', 'muted pad', 'No journal entries yet. Each argus-reviewer run writes one.'))
    return
  }
  const grid = el('div', 'journals')
  const hist = el('div')
  const rows = js.slice(-8).reverse().map((j) => [
    statusTag(j.ok ? 'passed' : 'failed', 'compact'),
    el('span', 'data', j.runId),
    String(j.steps),
    String(j.errors),
    usd6(j.costUsd),
  ])
  hist.append(table(['Result', 'Run', 'Steps', 'Errors', 'Cost'], rows, { numeric: [2, 3, 4], caption: 'Recent journals' }))
  const spark = el('figure', 'spark')
  const canvas = el('canvas')
  canvas.setAttribute('role', 'img')
  spark.append(canvas, el('figcaption', 'dim', 'Cost per run, oldest to newest. Hollow marks failed.'))
  hist.append(spark)
  grid.append(hist)
  const latest = el('div', 'latest')
  const j = state.journal
  if (j) {
    latest.append(el('h4', 'doc-h', `Latest: ${j.runId}`))
    const errs = (j.errors ?? []).slice(-6)
    if (errs.length === 0) latest.append(el('p', 'muted', 'No errors recorded.'))
    for (const e of errs) {
      const row = el('div', 'errrow')
      row.append(use(CHROME, 'close', 'icon tone-failed'), el('span', 'data', e.phase ?? e.stage ?? 'error'), el('span', '', String(e.message ?? e)))
      latest.append(row)
    }
  }
  grid.append(latest)
  box.append(grid)
  requestAnimationFrame(() => sparkline(canvas, js))
}
