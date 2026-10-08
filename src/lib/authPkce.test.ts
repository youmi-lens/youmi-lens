import { describe, expect, it } from 'vitest'
import { checkPkceAuthorizeUrl, isPlausibleAuthCode } from './authPkce'

const base = 'https://fake-project.supabase.test/auth/v1/authorize?provider=google&redirect_to=lecturecompanion-qa1015%3A%2F%2Fauth-callback'

describe('checkPkceAuthorizeUrl — only a real S256 PKCE flow may open the browser', () => {
  it('accepts S256 with a challenge (any case of the method)', () => {
    for (const method of ['s256', 'S256']) {
      expect(checkPkceAuthorizeUrl(`${base}&code_challenge=abcDEF_-123&code_challenge_method=${method}`)).toEqual({ ok: true })
    }
  })

  it('refuses the silent `plain` downgrade (the challenge would BE the verifier, visible in the URL)', () => {
    expect(checkPkceAuthorizeUrl(`${base}&code_challenge=abc&code_challenge_method=plain`)).toEqual({ ok: false, reason: 'challenge_method_not_s256' })
  })

  it('refuses a missing / empty method and a missing / blank challenge (an implicit-flow URL has neither)', () => {
    expect(checkPkceAuthorizeUrl(`${base}&code_challenge=abc`)).toEqual({ ok: false, reason: 'challenge_method_not_s256' })
    expect(checkPkceAuthorizeUrl(`${base}&code_challenge=abc&code_challenge_method=`)).toEqual({ ok: false, reason: 'challenge_method_not_s256' })
    expect(checkPkceAuthorizeUrl(base)).toEqual({ ok: false, reason: 'missing_code_challenge' })
    expect(checkPkceAuthorizeUrl(`${base}&code_challenge=&code_challenge_method=s256`)).toEqual({ ok: false, reason: 'missing_code_challenge' })
    expect(checkPkceAuthorizeUrl(`${base}&code_challenge=%20&code_challenge_method=s256`)).toEqual({ ok: false, reason: 'missing_code_challenge' })
  })

  it('refuses anything that is not a parseable URL', () => {
    for (const bad of ['', 'not a url', undefined, null]) expect(checkPkceAuthorizeUrl(bad as never)).toEqual({ ok: false, reason: 'unparseable_url' })
  })

  it('never echoes the challenge value in its result', () => {
    expect(JSON.stringify(checkPkceAuthorizeUrl(`${base}&code_challenge=SECRETCHALLENGE&code_challenge_method=plain`))).not.toContain('SECRETCHALLENGE')
  })
})

describe('isPlausibleAuthCode', () => {
  it('accepts opaque tokens: UUIDs and URL-safe strings up to 512 chars', () => {
    for (const ok of ['abc123', 'C1', '3f2a9c0e-7b1d-4c55-9a2e-0d6f5b8e1a44', 'pkce_AbC-1.2~3', 'a'.repeat(512)]) expect(isPlausibleAuthCode(ok), ok).toBe(true)
  })

  it('rejects empty, padded, separators, markup, control characters, oversized and non-strings', () => {
    for (const bad of ['', ' ', 'a b', 'a/b', 'a\\b', '../x', 'a?b', 'a&b', 'a=b', 'a#b', '<x>', "a'b", 'a"b', 'a\nb', 'a\u0000b', 'é', 'a'.repeat(513)]) expect(isPlausibleAuthCode(bad), JSON.stringify(bad)).toBe(false)
    for (const bad of [undefined, null, 5, {}, [], true]) expect(isPlausibleAuthCode(bad as never)).toBe(false)
  })
})
