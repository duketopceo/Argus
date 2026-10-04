/**
 * Ocellus design tokens — dark theme, mirror of assets/brand/tokens.json.
 * Source of truth: DESIGN.md → scripts/brand → tokens.json. Hand-synced;
 * if DESIGN.md changes, re-extract rather than editing hexes ad hoc.
 */
export const color = {
  canvas: '#0C0E12',
  surface: '#14171C',
  surfaceSunk: '#090B0E',
  raised: '#1B1F26',
  hairline: '#272C34',
  controlBorder: '#666E7A',
  ink: '#E8EBF0',
  ink2: '#B4BBC6',
  ink3: '#8A929E',
  accent: '#7D91FF',
  accentTint: '#1A2140',
  onAccent: '#0C0E12',
  passed: '#3CCF94',
  passedTint: '#10241C',
  failed: '#FF6E6A',
  failedTint: '#2A1414',
  caution: '#F0B03C',
  cautionTint: '#2A2010',
} as const;

export const motion = {
  instant: 100,
  state: 180,
  panel: 260,
  easeOut: [0.2, 0, 0, 1] as const,
  easeInOut: [0.4, 0, 0.2, 1] as const,
} as const;

export const radius = {sm: 6, md: 10, lg: 14} as const;

export const font = {
  grotesk: "'Schibsted Grotesk', sans-serif",
  mono: "'Martian Mono', monospace",
} as const;

/** Status → display color on dark canvas. */
export const statusColor = {
  passed: color.passed,
  failed: color.failed,
  skipped: color.ink3,
  inconclusive: color.caution,
  unavailable: color.ink3,
  blocked: color.failed,
} as const;

export type StatusName = keyof typeof statusColor;
