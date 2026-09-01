import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LanguageSelect, type LanguageSelectOption } from './LanguageSelect'

const OPTIONS: LanguageSelectOption[] = [
  { value: 'en', label: 'English', availability: 'available' },
  { value: 'zh-Hans', label: '简体中文', availability: 'beta' },
  { value: 'ja', label: '日本語', availability: 'not-enabled' },
]

const statusLabel = (a: LanguageSelectOption['availability']) =>
  a === 'available' ? 'Available' : a === 'beta' ? 'Beta' : 'Not enabled'

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
