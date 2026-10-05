import { describe, expect, it } from 'vitest'
import { INTERIM_RULES, scriptForSource, shouldTranslateInterim } from './liveTranslationPolicy.mjs'
import { createLiveTranslationSession } from './liveTranslationSession.mjs'

/** The rule exactly as it shipped in liveRealtimeWs.mjs before this change. */
function legacyShouldTranslateInterim(text, lastTranslatedInterimEn, lastTranslatedInterimAt, nowMs) {
  const t = text.trim()
  if (!t || t === lastTranslatedInterimEn) return false
  if (/[.!?,;:…]\s*$/.test(t)) return true
  if (!lastTranslatedInterimEn) return t.length >= 6
  if (t.length - lastTranslatedInterimEn.length >= 14) return true
  return nowMs - lastTranslatedInterimAt >= 520 && t.length > lastTranslatedInterimEn.length + 4
}

describe('interim policy — Latin scripts are EXACTLY the previous rule', () => {
  it('matches the legacy function on a dense sweep of inputs', () => {
    const words = ['Hello', 'there', 'everyone', 'we', 'start', 'with', 'gradient', 'descent', 'today.', 'and,', 'then', 'a']
    let checked = 0
    for (let n = 0; n <= 12; n++) {
      const text = words.slice(0, n).join(' ')
      for (const last of ['', 'Hello', 'Hello there', text.slice(0, Math.max(0, text.length - 3))]) {
        for (const dt of [0, 300, 520, 900]) {
          expect(shouldTranslateInterim(text, { lastText: last, lastAt: 1000, now: 1000 + dt, script: 'latin' }))
            .toBe(legacyShouldTranslateInterim(text, last, 1000, 1000 + dt))
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('the Latin numbers are the ones that shipped', () => {
    expect(INTERIM_RULES.latin).toMatchObject({ firstMin: 6, growth: 14, timeMs: 520, timeGrowth: 4 })
  })

  it.each(['en', 'fr', 'es'])('%s uses the Latin rule', (lang) => {
    expect(scriptForSource(lang)).toBe('latin')
  })
})

describe('interim policy — dense scripts translate sooner (fewer characters carry a word)', () => {
  it.each(['zh-Hans', 'ja', 'ko'])('%s uses the dense-script rule', (lang) => {
    expect(scriptForSource(lang)).toBe('cjk')
  })

  const cjk = (text, last = '', dt = 0) => shouldTranslateInterim(text, { lastText: last, lastAt: 1000, now: 1000 + dt, script: 'cjk' })

  it('the first fragment is translated at 3 characters (the English rule waited for 6)', () => {
    expect(cjk('今日は')).toBe(true)
    expect(cjk('今日')).toBe(false)
    expect(shouldTranslateInterim('今日は', { lastText: '', lastAt: 0, now: 0, script: 'latin' })).toBe(false)
  })

  it('then +10 characters of growth, or an 800 ms gate with +4 characters', () => {
    expect(cjk('今日は機械学習について話します', '今日は機械', 0)).toBe(true) // +10
    expect(cjk('今日は機械学習につい', '今日は機械', 300)).toBe(false) // +5, too soon
    expect(cjk('今日は機械学習につい', '今日は機械', 850)).toBe(true) // +5 after 800 ms
    expect(cjk('今日は機械学', '今日は機械', 850)).toBe(false) // only +1
  })

  it('a sentence-final mark always triggers, and an unchanged text never does', () => {
    expect(cjk('今日は。', '今日は')).toBe(true)
    expect(cjk('今日は機械', '今日は機械')).toBe(false)
  })
})

describe('live translation session — grouping and identity', () => {
  function make(extra = {}) {
    const sent = []
    let nowMs = 0
    const timers = []
    const translateCalls = []
    const session = createLiveTranslationSession({
      wsSessionId: 'abc',
      translationLanguage: 'en',
      sourceScript: 'cjk',
      isEnabled: () => true,
      translateText: async (t, target, source) => { translateCalls.push([t, target, source]); return `T(${t})` },
      qwenSource: { name: 'Simplified Chinese' },
      qwenTarget: { name: 'English' },
      send: (p) => sent.push(p),
      getFinalSeq: () => 0,
      now: () => nowMs,
      setTimer: (fn, ms) => { const h = { fn, at: nowMs + ms }; timers.push(h); return h },
      clearTimer: (h) => { if (h) h.cancelled = true },
      info: () => undefined,
      warn: () => undefined,
      ...extra,
    })
    const tick = async (ms) => {
      nowMs += ms
      for (const h of timers.filter((x) => !x.cancelled && !x.done && x.at <= nowMs)) { h.done = true; h.fn() }
      for (let i = 0; i < 8; i++) await Promise.resolve()
    }
    return { session, sent, tick, translateCalls }
  }

  it('the same final reported twice is listed once', async () => {
    const { session, sent, tick } = make()
    session.noteFinal('abc:1', '今天我们讲排序')
    session.noteFinal('abc:1', '今天我们讲排序')
    session.noteFinal('abc:2', '算法。')
    await tick(1)
    expect(sent.at(-1).source_ids).toEqual(['abc:1', 'abc:2'])
  })

  it('clear() drops a pending group without translating it', async () => {
    const { session, sent, tick } = make()
    session.noteFinal('abc:1', '今天我们讲排序')
    session.clear()
    await tick(2000)
    expect(sent).toHaveLength(0)
  })

  it('each group is translated from the lecture\'s source into its target', async () => {
    const { session, translateCalls, tick } = make()
    session.noteFinal('abc:1', '今天我们讲排序。')
    await tick(1)
    expect(translateCalls).toEqual([['今天我们讲排序。', 'English', 'Simplified Chinese']])
  })
})
