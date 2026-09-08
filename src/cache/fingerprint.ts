/**
 * Fingerprint record per KTD5: the durable, replayable identity of a single
 * model-resolved step.  Resolve compares a freshly captured element region
 * against the stored hash and verifies the a11y snippet is still present.
 *
 * The region hash is a simple 64-bit average-hash over the raw bytes of the
 * cropped JPEG screenshot region.  It is fast, dependency-free, and stable
 * enough for pinned-viewport fixtures.
 */

export interface Bbox {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface ActionPayload {
  action: 'click' | 'type' | 'pressKeys' | 'scroll' | 'wait' | 'done' | 'fail'
  x?: number
  y?: number
  text?: string
  keys?: string[]
  dx?: number
  dy?: number
  ms?: number
}

export interface FingerprintRecord {
  instruction: string
  action: ActionPayload
  bbox: Bbox
  clickPoint: Point
  model: string
  a11ySnippet: string
  regionHash: string
}

export interface ResolveResult {
  matched: boolean
  currentHash: string
  regionMatched: boolean
  a11yMatched: boolean
}

export function computeRegionHash(buffer: Buffer, bits = 64): string {
  if (buffer.length === 0) {
    return '0'.repeat(Math.ceil(bits / 4))
  }

  const chunk = Math.max(1, Math.floor(buffer.length / bits))
  const means: number[] = []
  let total = 0

  for (let i = 0; i < bits; i++) {
    const start = i * chunk
    const end = Math.min(start + chunk, buffer.length)
    let sum = 0
    let count = 0
    for (let j = start; j < end; j++) {
      sum += buffer[j] ?? 0
      count++
    }
    const mean = count > 0 ? sum / count : 0
    means.push(mean)
    total += mean
  }

  const globalMean = total / bits
  let hash = 0n
  for (let i = 0; i < bits; i++) {
    if ((means[i] ?? 0) >= globalMean) {
      hash |= 1n << BigInt(i)
    }
  }

  return hash.toString(16).padStart(Math.ceil(bits / 4), '0')
}

export class Fingerprint {
  constructor(public readonly record: FingerprintRecord) {}

  resolve(regionScreenshot: Buffer, a11yYaml: string): ResolveResult {
    const currentHash = computeRegionHash(regionScreenshot)
    const regionMatched = currentHash === this.record.regionHash
    const a11yMatched = a11yYaml.includes(this.record.a11ySnippet)
    return {
      matched: regionMatched && a11yMatched,
      currentHash,
      regionMatched,
      a11yMatched,
    }
  }

  mismatch(regionScreenshot: Buffer, a11yYaml: string): boolean {
    return !this.resolve(regionScreenshot, a11yYaml).matched
  }
}
