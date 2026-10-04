export function formatPrice(cents: number, currency: string): string {
  const whole = Math.floor(cents / 100)
  const frac = String(cents % 100).padStart(2, '0')
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$'
  return `${symbol}${whole}.${frac}`
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function summarize(label: string, cents: number, currency: string, iso: string): string {
  return `${label}: ${formatPrice(cents, currency)} on ${formatDate(iso)}`
}
