# Live translation on `/api/live-realtime-ws`

The persistent live socket is the single live-translation path for hosted clients (iPad, Desktop).
`POST /api/translate-caption` is kept for other callers and as a fallback, but Desktop hosted live
captions do not use it.

## Events (server → client)

Legacy fields are unchanged; the fields marked **new** are additive.

| event | fields |
|---|---|
| `stream_interim` | `text`, `transcript`, `caption`, **`final_id`** — the `stream_final` id this interim will become |
| `stream_final` | `id` (`<wsSession>:<n>`), `text`, `transcript`, `caption` |
| `stream_translation` (draft) | `id` (`<ws>:draft:<n>`), `translated_text`, `translation_language`, `translation_zh`*, `is_final:false`, `source_text`, **`draft_of`** (= the `final_id` above), **`revision`** (monotonic request ticket) |
| `stream_translation` (final) | `id` (the LAST covered final id), `translated_text`, `translation_language`, `translation_zh`*, `is_final:true`, **`source_ids`** (every covered `stream_final` id, in order, no duplicates), **`source_text`** |

\* `translation_zh` only when the target is `zh-Hans`.

A final translation can cover several finals: the server buffers ASR fragments into a sentence
(`liveTranslationBuffer.mjs`) and translates the sentence as one unit. `id` stays the last id for
older clients; `source_ids` names every fragment so a client never has to infer membership from
position, arrival order or timing.

`stream_stop` flushes the pending sentence immediately instead of waiting out the 1 s debounce.

## When nothing is translated

`translationLanguage === sourceLanguage` (Original only / same language) ⇒ `shouldTranslate` is false
and no translation request is made at all.

## Interim thresholds (`liveTranslationPolicy.mjs`)

Latin-script sources keep the original rule (first fragment at 6 characters, +14 characters, or 520 ms
and +4 characters; boundary on `. ! ? , ; : …`). Chinese / Japanese / Korean sources use 3 characters,
+10 characters, or 800 ms and +4 characters, boundary on `. ! ? … 。 ！ ？`.

## Known defect in the HTTP route (not changed here)

`handleHostedTranslateCaption` calls `translateText(text, targetName)` and never passes a source
language, so `translateText` defaults `source = 'English'`. For Chinese → English the system prompt
therefore reads "translate … from English into English". The WebSocket path passes the real source
(`qwenLanguageFor(sourceLanguage).name`). A fix would accept an optional `sourceLanguage` in the
request body; it is deliberately left for a separate change.
