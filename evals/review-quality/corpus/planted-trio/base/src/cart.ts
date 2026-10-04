export interface CartItem {
  id: string
  price: number
  qty: number
}

export interface Cart {
  items: CartItem[]
}

export function lineTotal(item: CartItem): number {
  return item.price * item.qty
}

export function cartTotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + lineTotal(item), 0)
}

export function applyCoupon(total: number, pct: number): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new RangeError('invalid coupon pct')
  }
  return total * (1 - pct / 100)
}

export async function persistCart(cart: Cart, path: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, JSON.stringify(cart, null, 2), 'utf8')
}
