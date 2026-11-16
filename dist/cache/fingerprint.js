/**
 * Fingerprint record per KTD5: the durable, replayable identity of a single
 * model-resolved step.  Resolve compares a freshly captured element region
 * against the stored hash and verifies the a11y snippet is still present.
 *
 * The region hash is a simple 64-bit average-hash over the raw bytes of the
 * cropped JPEG screenshot region.  It is fast, dependency-free, and stable
 * enough for pinned-viewport fixtures.
 */
export function computeRegionHash(buffer, bits = 64) {
    if (buffer.length === 0) {
        return '0'.repeat(Math.ceil(bits / 4));
    }
    const chunk = Math.max(1, Math.floor(buffer.length / bits));
    const means = [];
    let total = 0;
    for (let i = 0; i < bits; i++) {
        const start = i * chunk;
        const end = Math.min(start + chunk, buffer.length);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
            sum += buffer[j] ?? 0;
            count++;
        }
        const mean = count > 0 ? sum / count : 0;
        means.push(mean);
        total += mean;
    }
    const globalMean = total / bits;
    let hash = 0n;
    for (let i = 0; i < bits; i++) {
        if ((means[i] ?? 0) >= globalMean) {
            hash |= 1n << BigInt(i);
        }
    }
    return hash.toString(16).padStart(Math.ceil(bits / 4), '0');
}
export class Fingerprint {
    record;
    constructor(record) {
        this.record = record;
    }
    resolve(regionScreenshot, a11yYaml) {
        const currentHash = computeRegionHash(regionScreenshot);
        const regionMatched = currentHash === this.record.regionHash;
        const a11yMatched = a11yYaml.includes(this.record.a11ySnippet);
        return {
            matched: regionMatched && a11yMatched,
            currentHash,
            regionMatched,
            a11yMatched,
        };
    }
    mismatch(regionScreenshot, a11yYaml) {
        return !this.resolve(regionScreenshot, a11yYaml).matched;
    }
}
/** FNV-1a 32-bit hash - stable content hash for the a11y snapshot text. */
export function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}
const IDENTITY_WORD = /[a-z0-9]+/g;
function identityWords(text) {
    const words = (text.toLowerCase().match(IDENTITY_WORD) ?? []).filter((w) => !/^\d+$/.test(w));
    return new Set(words);
}
/**
 * Does the element found by a heal look like the element that was recorded?
 * Compares accessible names, not pixels: the names must share most of their
 * words, and a name far longer than the recorded one is rejected (that is a
 * container whose text merely includes the label, such as a whole panel).
 * An empty recorded name carries no identity, so it never blocks a heal.
 */
export function snippetsIdentityMatch(recorded, current) {
    const a = identityWords(recorded);
    if (a.size === 0)
        return true;
    const b = identityWords(current);
    if (b.size === 0)
        return false;
    let shared = 0;
    for (const w of a)
        if (b.has(w))
            shared++;
    const small = Math.min(a.size, b.size);
    const large = Math.max(a.size, b.size);
    return shared / small >= 0.6 && large <= small * 3 + 2;
}
/**
 * Is `snippet` the text of a container that merely includes `label`, rather
 * than the element the label names? True when the snippet has far more words
 * than the label (more than three times plus two).
 */
export function snippetLooksLikeContainer(label, snippet) {
    const l = identityWords(label).size;
    if (l === 0)
        return false;
    return identityWords(snippet).size > l * 3 + 2;
}
