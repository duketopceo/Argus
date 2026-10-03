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
  let sum = 0
  for (const item of cart.items) {
    sum += item.price
  }
  return sum
}

export function applyCoupon(total: number, pct: number): number {
  return total * (1 - pct / 100)
}

export async function persistCart(cart: Cart, path: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  writeFile(path, JSON.stringify(cart, null, 2), 'utf8')
}
