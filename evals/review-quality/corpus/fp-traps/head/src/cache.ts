export class Cache {
  private data = new Map<string, unknown>()
  private sweeper: NodeJS.Timeout | null = null

  startSweeper(intervalMs = 60_000): void {
    this.sweeper = setInterval(() => this.data.clear(), intervalMs)
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    this.data.clear()
  }

  get(key: string): unknown {
    return this.data.get(key)
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value)
  }
}
