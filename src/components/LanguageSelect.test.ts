import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LanguageSelect, type LanguageSelectOption } from './LanguageSelect'

const SRC = new URL('..', import.meta.url).pathname

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const allFiles = walk(SRC)
const allCss = allFiles
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')
const allTsx = allFiles.filter((f) => f.endsWith('.tsx')).map((f) => readFileSync(f, 'utf8'))

const OPTIONS: LanguageSelectOption[] = [
  { value: 'en', label: 'English', availability: 'available' },
  { value: 'zh-Hans', label: '简体中文', availability: 'beta' },
  { value: 'ja', label: '日本語', availability: 'not-enabled' },
]

const statusLabel = (a: LanguageSelectOption['availability']) =>
  a === 'available' ? 'Available' : a === 'beta' ? 'Beta' : 'Not enabled'

describe('QA17 — visually-hidden labels must use a class that actually exists', () => {
  it('the field-name span uses the real helper class, so it is hidden rather than rendered as text', () => {
    const html = renderToStaticMarkup(
      createElement(LanguageSelect, { label: 'App language', value: 'en', options: OPTIONS, statusLabel, onChange: () => undefined }),
    )
    expect(html).toContain('<span class="v2-sr-only">App language</span>')
    expect(html).not.toContain('class="sr-only"')
  })

  it('every visually-hidden class name used anywhere in the app is defined in a stylesheet', () => {
    // The QA16 bug in one line: `class="sr-only"` was never defined in any
    // sheet this app loads, so the span rendered as ordinary visible text and
    // the row read "App language English". Nothing caught it because the
    // markup was correct — only the class name was fictional.
    const used = new Set<string>()
    for (const src of allTsx) {
      for (const m of src.matchAll(/className="([^"]*)"/g)) {
        for (const cls of m[1].split(/\s+/)) {
          if (/sr-only|visually-hidden|screen-reader/i.test(cls)) used.add(cls)
        }
      }
    }
    expect(used.size).toBeGreaterThan(0)
    for (const cls of used) {
      expect(allCss, `.${cls} is used in JSX but defined in no stylesheet`).toContain(`.${cls}`)
    }
  })
})

describe('LanguageSelect — QA16 redundant-label regression', () => {
  it('an available option shows only its label — no "· Available" suffix in the closed control', () => {
    const html = renderToStaticMarkup(
      createElement(LanguageSelect, { label: 'App language', value: 'en', options: OPTIONS, statusLabel, onChange: () => undefined }),
    )
    expect(html).toContain('>English<')
    expect(html).not.toContain('English · Available')
  })

  it('a disabled (beta/not-enabled) option keeps its status suffix — it explains why the option cannot be picked', () => {
    const html = renderToStaticMarkup(
      createElement(LanguageSelect, { label: 'Caption language', value: 'en', options: OPTIONS, statusLabel, onChange: () => undefined }),
    )
    expect(html).toContain('简体中文 · Beta')
    expect(html).toContain('日本語 · Not enabled')
  })

  it('disabled options are actually marked disabled', () => {
    const html = renderToStaticMarkup(
      createElement(LanguageSelect, { label: 'Caption language', value: 'en', options: OPTIONS, statusLabel, onChange: () => undefined }),
    )
    expect(html.match(/disabled=""/g)?.length).toBe(2)
  })
})
