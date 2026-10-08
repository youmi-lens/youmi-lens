/**
 * Build-aware callback identity. macOS custom schemes are global, so each build must accept ONLY its own
 * `<scheme>://auth-callback` and never act on another Youmi Lens build's callback.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deriveQaBuildIdentity, qaConfigOverlay } from '../../scripts/qa-build-identity.mjs'
import {
  buildAuthCallbackUrl,
  filterAuthCallbackUrls,
  isAuthCallbackForScheme,
  isValidAuthScheme,
} from './authIdentity'

const PROD = 'lecturecompanion'
const QA15 = 'lecturecompanion-qa1015'
const QA16 = 'lecturecompanion-qa1016'
const cb = (s: string, rest = '') => `${s}://auth-callback${rest}`

describe('scheme family', () => {
  it('accepts Production and QA tags only', () => {
    for (const ok of [PROD, QA15, QA16, 'lecturecompanion-qa9']) expect(isValidAuthScheme(ok), ok).toBe(true)
    for (const bad of ['', 'lecturecompanion-qa', 'lecturecompanion-evil', 'lecturecompanion-qa1015.evil', 'lecturecompanion-qa1015://', 'LECTURECOMPANION', 'youmilens', 'lecturecompanion-qa-x', 'lecturecompanion-qa' + 'a'.repeat(17), null, undefined, 5])
      expect(isValidAuthScheme(bad as never), String(bad)).toBe(false)
  })

  it('callback URLs are exactly <scheme>://auth-callback', () => {
    expect(buildAuthCallbackUrl(PROD)).toBe('lecturecompanion://auth-callback')
    expect(buildAuthCallbackUrl(QA15)).toBe('lecturecompanion-qa1015://auth-callback')
    expect(() => buildAuthCallbackUrl('evil')).toThrow('invalid_auth_scheme')
  })
})

describe('Production build', () => {
  it('accepts its callback in every real shape (bare, query, hash, trailing slash)', () => {
    for (const rest of ['', '?code=abc', '#access_token=AT&refresh_token=RT', '/', '/?x=1', '/#y=2', '?error=access_denied&error_description=x'])
      expect(isAuthCallbackForScheme(cb(PROD, rest), PROD), rest).toBe(true)
  })
  it('rejects QA schemes', () => {
    expect(isAuthCallbackForScheme(cb(QA15), PROD)).toBe(false)
    expect(isAuthCallbackForScheme(cb(QA16, '#access_token=x'), PROD)).toBe(false)
  })
})

describe.each([
  ['QA1015', QA15, QA16],
  ['QA1016', QA16, QA15],
])('%s build', (_n, own, other) => {
  it('accepts only its own scheme', () => {
    expect(isAuthCallbackForScheme(cb(own, '#access_token=x'), own)).toBe(true)
    expect(isAuthCallbackForScheme(cb(PROD), own)).toBe(false)
    expect(isAuthCallbackForScheme(cb(other), own)).toBe(false)
  })
})

describe('malformed and crafted URLs are rejected', () => {
  it.each([
    ['wrong host', `${QA15}://evil`],
    ['wrong host with callback path', `${QA15}://evil/auth-callback`],
    ['host suffix', `${QA15}://auth-callback.evil.com`],
    ['host prefix', `${QA15}://xauth-callback`],
    ['userinfo trick', `${QA15}://auth-callback@evil.com`],
    ['userinfo trick 2', `${QA15}://evil@auth-callback`],
    ['extra path', `${QA15}://auth-callback/evil`],
    ['double slash', `${QA15}://auth-callback//x`],
    ['single slash scheme', `${QA15}:/auth-callback`],
    ['no authority', `${QA15}:auth-callback`],
    ['embedded second URL', `https://evil.example/?u=${QA15}://auth-callback`],
    ['leading junk', `x${QA15}://auth-callback`],
    ['https lookalike', 'https://lecturecompanion-qa1015/auth-callback'],
    ['empty', ''],
    ['whitespace', '   '],
    ['arbitrary ://', 'foo://bar'],
  ])('%s', (_n, url) => {
    expect(isAuthCallbackForScheme(url, QA15)).toBe(false)
  })

  it('non-string input and a corrupt build scheme never match', () => {
    expect(isAuthCallbackForScheme(undefined, QA15)).toBe(false)
    expect(isAuthCallbackForScheme({} as never, QA15)).toBe(false)
    expect(isAuthCallbackForScheme(cb(PROD), 'evil')).toBe(false)
  })

  it('filter drops everything but this build’s callbacks', () => {
    const urls = [cb(PROD), cb(QA15, '#a=1'), cb(QA16), `${QA15}://evil`, 'foo://bar']
    expect(filterAuthCallbackUrls(urls, QA15)).toEqual([cb(QA15, '#a=1')])
    expect(filterAuthCallbackUrls(urls, PROD)).toEqual([cb(PROD)])
  })
})

describe('single source of build identity (QA overlay)', () => {
  it('derives bundle id, product name and scheme from one tag', () => {
    expect(deriveQaBuildIdentity('1015')).toEqual({
      tag: '1015',
      productName: 'Youmi Lens QA 1015',
      identifier: 'com.youmilens.desktop.qa1015',
      scheme: 'lecturecompanion-qa1015',
      callback: 'lecturecompanion-qa1015://auth-callback',
    })
    expect(qaConfigOverlay('1016')).toEqual({
      productName: 'Youmi Lens QA 1016',
      identifier: 'com.youmilens.desktop.qa1016',
      plugins: { 'deep-link': { desktop: { schemes: ['lecturecompanion-qa1016'] } } },
    })
  })

  it('every derivable QA scheme is inside the runtime family, and bad tags are refused', () => {
    for (const tag of ['1015', '1016', 'a', 'rc2', 'x'.repeat(16)]) {
      const id = deriveQaBuildIdentity(tag)
      expect(isValidAuthScheme(id.scheme), tag).toBe(true)
      expect(id.callback).toBe(buildAuthCallbackUrl(id.scheme))
    }
    for (const bad of ['', 'A1', '10 15', '10.15', '../x', 'x'.repeat(17), undefined]) expect(() => deriveQaBuildIdentity(bad as never), String(bad)).toThrow('invalid_qa_tag')
  })

  it('the Production config registers exactly the Production scheme (unchanged)', () => {
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
    expect(conf.identifier).toBe('com.youmilens.desktop')
    expect(conf.plugins['deep-link'].desktop.schemes).toEqual([PROD])
  })
})

describe('Railway HTTPS bridge cannot become an open redirector', () => {
  const server = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8')
  const route = server.slice(server.indexOf("app.get('/tauri-auth-callback'"), server.indexOf('const server = createServer'))

  it('forwards only to the hardcoded Production callback, never to a request-supplied scheme or URL', () => {
    expect(route).toContain("var target = 'lecturecompanion://auth-callback' + window.location.search + window.location.hash;")
    const code = route.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/req\.|_req\.(query|params|url|originalUrl)/)
    expect(code).not.toMatch(/scheme|redirect_to|returnTo|next=/i)
    expect((code.match(/location\.replace\(/g) ?? []).length).toBe(1)
    expect((code.match(/:\/\//g) ?? []).length).toBe(1) // the one hardcoded target
  })
})

describe('Rust / wiring (static)', () => {
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  it('reads the scheme from the Tauri config, exposes it as a command, and has no hardcoded scheme in logic', () => {
    expect(lib).toContain('.get("deep-link")?')
    expect(lib).toMatch(/fn auth_callback_scheme/)
    expect(lib).toMatch(/auth_callback_scheme\n\s*\]\)/)
    const logic = lib.slice(0, lib.indexOf('#[cfg(all(test'))
    const code = logic.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('lecturecompanion')
  })
})
