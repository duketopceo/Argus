import { describe, expect, it } from 'vitest'

import { KEYMAP, keyAction, listedAs } from '../../electron/ui/keys.js'

// Desk keyboard model (plan U13, R21): j/k runs, [/] lanes, / filter,
// ? help, Enter opens, Esc closes. Typing in a field never triggers a key.

const press = (key: string, ctx: Record<string, unknown> = {}) =>
  keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...ctx }, { inField: false, overlay: false, ...ctx })

describe('keyAction', () => {
  it('maps the documented keys', () => {
    expect(press('j')).toBe('next-run')
    expect(press('k')).toBe('prev-run')
    expect(press('ArrowDown')).toBe(undefined) // listbox rows own arrows
    expect(press(']')).toBe('next-lane')
    expect(press('[')).toBe('prev-lane')
    expect(press('/')).toBe('filter')
    expect(press('?')).toBe('help')
    expect(press('Enter')).toBe('open')
    expect(press('Escape')).toBe('close')
    expect(press('r')).toBe('refresh')
    expect(press('x')).toBe(undefined)
  })

  it('ignores keys typed into a field, except Esc', () => {
    expect(press('j', { inField: true })).toBe(undefined)
    expect(press('/', { inField: true })).toBe(undefined)
    expect(press('?', { inField: true })).toBe(undefined)
    expect(press('Escape', { inField: true })).toBe('close')
  })

  it('ignores browser and system chords', () => {
    expect(press('j', { ctrlKey: true })).toBe(undefined)
    expect(press('r', { metaKey: true })).toBe(undefined)
    expect(press('[', { altKey: true })).toBe(undefined)
  })

  it('inside an overlay only Esc and ? act; the overlay owns the rest', () => {
    expect(press('j', { overlay: true })).toBe(undefined)
    expect(press('Enter', { overlay: true })).toBe(undefined)
    expect(press('Escape', { overlay: true })).toBe('close')
    expect(press('?', { overlay: true })).toBe('help')
  })

  it('every action the map produces is listed in the help sheet', () => {
    const listed = new Set(KEYMAP.map((k: { action: string }) => k.action))
    for (const key of ['j', 'k', ']', '[', '/', '?', 'Enter', 'Escape', 'r']) {
      expect(listed.has(listedAs(press(key))), key).toBe(true)
    }
    for (const k of KEYMAP) expect(k.keys.length).toBeGreaterThan(0)
  })
})
