export interface Db {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
}

export interface Req {
  headers: Record<string, string | string[] | undefined>
  query: Record<string, string | undefined>
}

export interface Res {
  status(code: number): Res
  json(body: unknown): void
  end(): void
}

export type Next = () => void

export function health(_req: Req, res: Res): void {
  res.json({ ok: true })
}

export async function getUserById(db: Db, req: Req, res: Res): Promise<void> {
  const id = req.query.id ?? ''
  const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`)
  res.json(rows)
}

export function requireAdmin(req: Req, res: Res, next: Next): void {
  if (req.headers['x-admin'] === 'true') {
    return next()
  }
  res.status(403).end()
}
