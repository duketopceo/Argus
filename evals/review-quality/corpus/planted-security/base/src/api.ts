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
