import type { ChangeEvent } from 'react'
import type { ContentLanguageCode, LanguageAvailability } from '../lib/contentLanguages'

export type LanguageSelectOption = {
  value: ContentLanguageCode
  label: string
  availability: LanguageAvailability
}

export function LanguageSelect({
  label,
  value,
  options,
  statusLabel,
  onChange,
}: {
  label: string
  value: ContentLanguageCode
  options: LanguageSelectOption[]
  statusLabel: (availability: LanguageAvailability) => string
  onChange: (value: ContentLanguageCode) => void
}) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange(event.target.value as ContentLanguageCode)
  }

  return (
    <label className="language-select">
      {/* `v2-sr-only`, NOT `sr-only`: `.sr-only` is not defined in any
          stylesheet this app loads, so this span rendered as ordinary visible
          text and the row read "App language English" — the field name on the
          left, then the name again next to the value. `.desktop-v2
          .v2-sr-only` is the real visually-hidden helper, so the label stays
          in the accessibility tree (alongside the select's own aria-label)
          while showing only the value on screen. */}
      <span className="v2-sr-only">{label}</span>
      <select aria-label={label} value={value} onChange={handleChange}>
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.availability !== 'available'}
          >
            {/* Only a DISABLED option needs its status spelled out (it explains why
                the option can't be picked). The closed control can only ever show
                the selected — necessarily available — option's text, so appending
                "· Available" there is pure noise: it repeats the fact that this
                choice is active without adding information. */}
            {option.availability === 'available' ? option.label : `${option.label} · ${statusLabel(option.availability)}`}
          </option>
        ))}
      </select>
    </label>
  )
}
