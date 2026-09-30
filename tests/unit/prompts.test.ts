import { describe, expect, it } from 'vitest'

import {
  buildActionMessages,
  buildExploreMessages,
  describeAction,
  exploreActionSchema,
} from '../../src/engine/prompts.js'

describe('describeAction', () => {
  it('renders click with coords and element label', () => {
    expect(describeAction({ action: 'click', x: 200, y: 130 }, 'button "Click me"')).toBe(
      'click "button \'Click me\'" @ (200,130)',
    )
  })

  it('omits the label when the snippet is empty or whitespace', () => {
    expect(describeAction({ action: 'click', x: 1, y: 2 }, '')).toBe('click @ (1,2)')
    expect(describeAction({ action: 'click', x: 1, y: 2 }, '   ')).toBe('click @ (1,2)')
    expect(describeAction({ action: 'click', x: 1, y: 2 })).toBe('click @ (1,2)')
  })

  it('keeps labels single-line under truncation', () => {
    const label = 'line one\nline two ' + 'x'.repeat(60)
    const out = describeAction({ action: 'click', x: 0, y: 0 }, label)
    expect(out).not.toContain('\n')
    expect(out.length).toBeLessThan(80)
  })

  it('renders the remaining action kinds with sane fallbacks', () => {
    expect(describeAction({ action: 'type', text: 'user@x.com' })).toBe('type "user@x.com"')
    expect(describeAction({ action: 'pressKeys', keys: ['Enter', 'Tab'] })).toBe('pressKeys Enter+Tab')
    expect(describeAction({ action: 'scroll', dx: 0, dy: 400 })).toBe('scroll (0,400)')
    expect(describeAction({ action: 'wait', ms: 500 })).toBe('wait 500ms')
    expect(describeAction({ action: 'click' })).toBe('click @ (?,?)')
  })
})

describe('buildActionMessages history block', () => {
  const observation = {
    screenshotJpeg: Buffer.from('x'),
    a11yYaml: '- button "Go"',
    width: 1280,
    height: 720,
  }

  const userText = (msgs: ReturnType<typeof buildActionMessages>) =>
    msgs
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')

  it('omits the block with no prior actions and renders numbered lines when present', () => {
    expect(userText(buildActionMessages('do x', observation))).not.toContain(
      'Steps already taken',
    )
    const withHistory = userText(
      buildActionMessages('do x', observation, [
        { action: { action: 'click', x: 10, y: 20 }, label: 'Go' },
        { action: { action: 'type', text: 'hi' } },
      ]),
    )
    expect(withHistory).toContain('Steps already taken')
    expect(withHistory).toContain('- #1 click "Go" @ (10,20)')
    expect(withHistory).toContain('- #2 type "hi"')
  })
})

describe('explore prompt surface (U4b)', () => {
  const observation = {
    screenshotJpeg: Buffer.from('x'),
    a11yYaml: '- link "About"',
    width: 1280,
    height: 720,
  }

  const userText = (msgs: ReturnType<typeof buildExploreMessages>) =>
    msgs
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')

  it('exploreActionSchema extends the action vocabulary with navigate + url', () => {
    const props = exploreActionSchema.schema.properties as Record<string, { enum?: string[] }>
    expect(props.action!.enum).toContain('navigate')
    expect(props.url).toBeDefined()
    expect(exploreActionSchema.schema.required).toEqual(['action', 'reasoning'])
    // `fail` is parse-accepted for transcript purposes but not proposed.
    expect(props.action!.enum).not.toContain('fail')
  })

  it('describeAction renders navigate with a truncated, quote-safe url', () => {
    expect(describeAction({ action: 'navigate', url: '/about', reasoning: 'r' })).toBe(
      'navigate /about',
    )
    const long = `/${'a'.repeat(100)}"q`
    const out = describeAction({ action: 'navigate', url: long, reasoning: 'r' })
    expect(out).not.toContain('"')
    expect(out.length).toBeLessThan(60)
  })

  it('system prompt carries the charter: same-origin, non-destructive, one action', () => {
    const msgs = buildExploreMessages(observation)
    const system = msgs[0]!.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    expect(system).toContain('exploratory QA')
    expect(system).toContain('Never propose a URL on another origin')
    expect(system).toContain('non-destructive')
  })

  it('renders the act transcript with resulting URLs and refusal notes', () => {
    const withHistory = userText(
      buildExploreMessages(observation, [
        {
          action: { action: 'navigate', url: '/about', reasoning: 'r' },
          url: 'http://app.test/about',
        },
        {
          action: { action: 'navigate', url: 'https://evil.example', reasoning: 'r' },
          url: 'http://app.test/about',
          note: 'refused: cross-origin',
        },
      ]),
    )
    expect(withHistory).toContain('- #1 navigate /about → http://app.test/about')
    expect(withHistory).toContain('(refused: cross-origin)')
  })
})
