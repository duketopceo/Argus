import { describe, expect, it } from 'vitest'
import { displayCorpusPath, redactEvalOutput } from '../../scripts/eval-privacy.mjs'

describe('eval artifact privacy', () => {
  it('redacts checkout and home paths in captured output', () => {
    expect(redactEvalOutput(
      'report /home/alice/project/evals/work/run; cache /home/alice/.cache',
      '/home/alice/project',
      '/home/alice',
    )).toBe('report <repo>/evals/work/run; cache <home>/.cache')
  })

  it('keeps repo corpus paths relative and hides external parents', () => {
    expect(displayCorpusPath('/home/alice/project/scripts/corpus.json', '/home/alice/project'))
      .toBe('scripts/corpus.json')
    expect(displayCorpusPath('/home/alice/private/corpus.json', '/home/alice/project'))
      .toBe('corpus.json')
  })
})
