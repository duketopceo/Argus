import { describe, expect, it } from 'vitest'

import { LANE_STATUSES } from '../../src/report/manifest.js'
import {
  LANE_STATUS_EMOJI,
  LANE_STATUS_ICON,
  LANE_STATUS_LABEL,
  PROOF_LEVELS,
  proofMeter,
  SEVERITIES,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  STATUS_GLYPH,
  VERDICT_LABEL,
  VERDICT_STATUS,
  VERDICTS,
  verdictGlyph,
} from '../../src/report/viewmodel.js'

describe('Ocellus status vocabulary (DESIGN.md section 6.7)', () => {
  it('maps every LaneStatus to exactly one text glyph and one lowercase word', () => {
    expect(Object.keys(STATUS_GLYPH).sort()).toEqual([...LANE_STATUSES].sort())
    for (const status of LANE_STATUSES) {
      expect([...STATUS_GLYPH[status]]).toHaveLength(1)
      expect(LANE_STATUS_LABEL[status]).toBe(LANE_STATUS_LABEL[status].toLowerCase())
    }
    expect(STATUS_GLYPH).toEqual({
      passed: '●',
      failed: '⊘',
      inconclusive: '◐',
      blocked: '⊖',
      unavailable: '◌',
      skipped: '–',
    })
  })

  it('never lets two statuses share a glyph', () => {
    const glyphs = Object.values(STATUS_GLYPH)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('keeps the legacy LANE_STATUS_ICON / LANE_STATUS_EMOJI exports until U4 and U13', () => {
    for (const status of LANE_STATUSES) {
      expect(LANE_STATUS_ICON[status]).toBeTruthy()
      expect(LANE_STATUS_EMOJI[status]).toBeTruthy()
    }
  })
})

describe('proof ladder (A4)', () => {
  it('fills notches left to right in ladder order', () => {
    expect([...PROOF_LEVELS]).toEqual(['suspected', 'corroborated', 'exercised', 'reproduced'])
    expect(PROOF_LEVELS.map((l) => proofMeter(l))).toEqual(['▰▱▱▱', '▰▰▱▱', '▰▰▰▱', '▰▰▰▰'])
  })

  it('maps an unknown or missing level to the empty meter instead of throwing', () => {
    expect(proofMeter('not_exercised')).toBe('▱▱▱▱')
    expect(proofMeter('')).toBe('▱▱▱▱')
    expect(proofMeter(undefined)).toBe('▱▱▱▱')
    expect(proofMeter('toString')).toBe('▱▱▱▱')
  })
})

describe('severity (A5) and verdict', () => {
  it('gives each severity a distinct geometric glyph and a word', () => {
    expect([...SEVERITIES]).toEqual(['bug', 'risk', 'nit', 'q'])
    expect(SEVERITY_GLYPH).toEqual({ bug: '◆', risk: '◈', nit: '○', q: '□' })
    expect(SEVERITY_LABEL).toEqual({ bug: 'bug', risk: 'risk', nit: 'nit', q: 'question' })
  })

  it('reuses status glyphs for verdicts, never a third set', () => {
    expect([...VERDICTS]).toEqual(['approve', 'needs_changes', 'pass'])
    const statusGlyphs = new Set(Object.values(STATUS_GLYPH))
    for (const v of VERDICTS) {
      expect(statusGlyphs.has(verdictGlyph(v))).toBe(true)
      expect(verdictGlyph(v)).toBe(STATUS_GLYPH[VERDICT_STATUS[v]])
    }
    expect(VERDICTS.map((v) => `${verdictGlyph(v)} ${VERDICT_LABEL[v]}`)).toEqual([
      '● approve',
      '⊘ needs changes',
      '● clean',
    ])
  })
})
