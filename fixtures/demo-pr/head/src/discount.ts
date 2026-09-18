export function applyDiscount(price: number, pct: number): number {
  if (pct < 0 || pct > 100) throw new RangeError('pct must be 0-100')
  const discounted = price * (1 - pct / 100)
  // Seeded demo bug: the percentage is applied a second time, so a 10%
  // discount yields 81% of the original price instead of 90%.
  return discounted * (1 - pct / 100)
}

export function totalWithTax(subtotal: number, taxRate: number): number {
  return Math.round(subtotal * (1 + taxRate) * 100) / 100
}
