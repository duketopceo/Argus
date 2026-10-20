import { describe, expect, it } from 'vitest'
import { gitHeaderKey, ghSubprocessEnv, resolveGitHost } from '../../src/github/host.js'

describe('resolveGitHost', () => {
  it('defaults to github.com when no env is set', () => {
    expect(resolveGitHost({})).toEqual({
      apiBase: 'https://api.github.com',
      webBase: 'https://github.com',
    })
  })

  it('honors the runner-provided GITHUB_API_URL verbatim minus a trailing slash', () => {
    expect(resolveGitHost({ GITHUB_API_URL: 'https://ghe.corp.example/api/v3/' }).apiBase).toBe(
      'https://ghe.corp.example/api/v3',
    )
  })

  it('derives the GHE api endpoint from GITHUB_SERVER_URL', () => {
    const host = resolveGitHost({ GITHUB_SERVER_URL: 'https://ghe.corp.example' })
    expect(host.webBase).toBe('https://ghe.corp.example')
    expect(host.apiBase).toBe('https://ghe.corp.example/api/v3')
  })

  it('maps github.com server urls to the api.github.com endpoint', () => {
    const host = resolveGitHost({ GITHUB_SERVER_URL: 'https://github.com' })
    expect(host.apiBase).toBe('https://api.github.com')
    expect(host.webBase).toBe('https://github.com')
  })

  it('derives the web base from an explicit api url', () => {
    const host = resolveGitHost({ GITHUB_API_URL: 'https://ghe.corp.example/api/v3' })
    expect(host.webBase).toBe('https://ghe.corp.example')
    const gh = resolveGitHost({ GITHUB_API_URL: 'https://api.github.com' })
    expect(gh.webBase).toBe('https://github.com')
  })

  it('lets ARGUS_ overrides beat the runner-provided variables', () => {
    const host = resolveGitHost({
      GITHUB_API_URL: 'https://api.github.com',
      GITHUB_SERVER_URL: 'https://github.com',
      ARGUS_GITHUB_API_URL: 'https://ghe.corp.example/api/v3',
      ARGUS_GITHUB_SERVER_URL: 'https://ghe.corp.example',
    })
    expect(host.apiBase).toBe('https://ghe.corp.example/api/v3')
    expect(host.webBase).toBe('https://ghe.corp.example')
  })

  it('keeps a nonstandard api url as the api base and derives nothing extra', () => {
    const host = resolveGitHost({ ARGUS_GITHUB_API_URL: 'https://ghe.corp.example/custom' })
    expect(host.apiBase).toBe('https://ghe.corp.example/custom')
    expect(host.webBase).toBe('https://ghe.corp.example')
  })

  it('throws on a malformed explicit host instead of retargeting to github.com', () => {
    expect(() => resolveGitHost({ ARGUS_GITHUB_API_URL: 'not a url' })).toThrow('ARGUS_GITHUB_API_URL')
    expect(() => resolveGitHost({ GITHUB_SERVER_URL: 'ftp://ghe.corp.example' })).toThrow('GITHUB_SERVER_URL')
  })
})

describe('host helpers', () => {
  it('builds the git extraheader key from the web base', () => {
    expect(gitHeaderKey({ apiBase: 'x', webBase: 'https://ghe.corp.example' })).toBe(
      'http.https://ghe.corp.example/.extraheader',
    )
  })

  it('exports GH_HOST for gh subprocesses only for non-default hosts', () => {
    expect(ghSubprocessEnv('https://github.com')).toEqual({})
    expect(ghSubprocessEnv('https://ghe.corp.example')).toEqual({
      GH_HOST: 'ghe.corp.example',
    })
  })
})
