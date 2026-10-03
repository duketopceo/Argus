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
