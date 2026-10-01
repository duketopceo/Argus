export interface User {
  id: string
  email: string | null
  tags: string[]
}

export function findUser(users: User[], id: string): User | undefined {
  return users.find((u) => u.id === id)
}

export function userCount(users: User[]): number {
  return users.length
}

export function userEmail(users: User[], id: string): string {
  const u = findUser(users, id)
  if (!u || !u.email) {
    throw new Error(`no email for ${id}`)
  }
  return u.email.toLowerCase()
}

export function daysSince(epochMs: number): number {
  // Deliberately floors: a partial day does not count as elapsed.
  return Math.floor((Date.now() - epochMs) / 86_400_000)
}
