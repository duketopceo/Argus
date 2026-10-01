export class Cache {
  private data = new Map<string, unknown>()

  get(key: string): unknown {
    return this.data.get(key)
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value)
  }
}
