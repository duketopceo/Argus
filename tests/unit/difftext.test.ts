import { describe, expect, it } from 'vitest'

import { addedLines } from '../../src/review/difftext.js'

describe('addedLines', () => {
  it('walks plain `+++ b/` headers with post-change line numbers', () => {
    const diff =
      'diff --git a/x.ts b/x.ts\n' +
      '--- a/x.ts\n' +
      '+++ b/x.ts\n' +
      '@@ -2,3 +2,4 @@\n' +
      ' ctx\n' +
      '-old\n' +
      '+new1\n' +
      '+new2\n' +
      ' tail\n'
    // new file range starts at 2: ctx=2, -old consumes old-side only,
    // +new1=3, +new2=4, tail=5.
    expect(addedLines(diff)).toEqual([
      { file: 'x.ts', line: 3, text: 'new1' },
      { file: 'x.ts', line: 4, text: 'new2' },
    ])
  })

  it('decodes git C-quoted `+++ "b/..."` headers (spaces, octal, escapes)', () => {
    // "b/f\303\251e.ts" is é in octal — the path a UTF-8 filename emits
    // under core.quotePath=true before our flags suppress it; producers
    // that missed the flags still parse here.
    const diff =
      'diff --git "a/f\\303\\251e.ts" "b/f\\303\\251e.ts"\n' +
      '--- "a/f\\303\\251e.ts"\n' +
      '+++ "b/f\\303\\251e.ts"\n' +
      '@@ -0,0 +1 @@\n' +
      '+hit\n'
    expect(addedLines(diff)).toEqual([
      { file: 'f\u00E9e.ts', line: 1, text: 'hit' },
    ])
  })

  it('decodes \\t, \\", and \\\\ escapes inside quoted paths', () => {
    const diff =
      'diff --git "a/we\\tird \\"name\\\\x.ts" "b/we\\tird \\"name\\\\x.ts"\n' +
      '--- "a/we\\tird \\"name\\\\x.ts"\n' +
      '+++ "b/we\\tird \\"name\\\\x.ts"\n' +
      '@@ -0,0 +1 @@\n' +
      '+hit\n'
    const [first] = addedLines(diff)
    expect(first?.file).toBe('we\tird "name\\x.ts')
  })

  it('skips deleted files — `+++ /dev/null` yields no added lines', () => {
    const diff =
      'diff --git a/gone.ts b/gone.ts\n' +
      '--- a/gone.ts\n' +
      '+++ /dev/null\n' +
      '@@ -1,2 +0,0 @@\n' +
      '-a\n-b\n'
    expect(addedLines(diff)).toEqual([])
  })

  it('a `diff --git` section resets the file — no carryover without `+++`', () => {
    // Malformed section: hunks with no `+++` header must not attribute
    // lines to the previous file.
    const diff =
      'diff --git a/ok.ts b/ok.ts\n' +
      '--- a/ok.ts\n+++ b/ok.ts\n@@ -0,0 +1 @@\n+good\n' +
      'diff --git a/mystery b/mystery\n' +
      '@@ -1 +1 @@\n+x\n+leak\n'
    expect(addedLines(diff)).toEqual([{ file: 'ok.ts', line: 1, text: 'good' }])
  })

  it('resumes numbering across multiple hunks', () => {
    const diff =
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n' +
      '@@ -1,2 +1,3 @@\n c1\n+n1\n' +
      '@@ -10,2 +11,3 @@\n c2\n+n2\n'
    expect(addedLines(diff)).toEqual([
      { file: 'x.ts', line: 2, text: 'n1' },
      { file: 'x.ts', line: 12, text: 'n2' },
    ])
  })

  it('treats `+++` inside a hunk as added content, not a header', () => {
    const diff =
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n' +
      '@@ -0,0 +1 @@\n' +
      '+++ b/fake.ts — literal plus-plus-plus text\n'
    const [first] = addedLines(diff)
    expect(first?.file).toBe('x.ts')
    expect(first?.text).toBe('++ b/fake.ts — literal plus-plus-plus text')
  })

  it('ignores metadata lines and malformed hunks without crashing', () => {
    const diff =
      'diff --git a/x.ts b/x.ts\n' +
      'index 111..222 100644\n' +
      'old mode 100644\n' +
      'new mode 100755\n' +
      '--- a/x.ts\n+++ b/x.ts\n' +
      '@@ malformed hunk header\n' +
      '+still-added\n' +
      '\\ No newline at end of file\n'
    const lines = addedLines(diff)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.file).toBe('x.ts')
    expect(lines[0]?.line).toBe(0) // malformed @@ → line 0 anchor
  })

  it('added lines before any `+++` header carry no file attribution', () => {
    const diff = '@@ -0,0 +1 @@\n+orphan\n'
    expect(addedLines(diff)).toEqual([])
  })
})
