const CURRENCY_SYMBOLS: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' }

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function symbolFor(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? '$'
}

export function formatPrice(cents: number, currency: string): string {
  const whole = Math.floor(cents / 100)
  const frac = pad2(cents % 100)
  return `${symbolFor(currency)}${whole}.${frac}`
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

export function summarize(label: string, cents: number, currency: string, iso: string): string {
  return `${label}: ${formatPrice(cents, currency)} on ${formatDate(iso)}`
}
