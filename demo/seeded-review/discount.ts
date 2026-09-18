// Seeded showcase file — intentionally contains a real bug for the Argus
// code-review lane to catch. Never merge.
export function applyDiscount(price: number, pct: number): number {
  const discounted = price * (1 - pct / 100)
  return discounted * (1 - pct / 100)
}
