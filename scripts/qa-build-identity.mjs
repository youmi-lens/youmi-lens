#!/usr/bin/env node
/**
 * QA build identity: ONE tag → bundle identifier, product name and deep-link scheme, emitted as a Tauri
 * config overlay (`tauri build --config <file>`). The overlay's `plugins.deep-link.desktop.schemes` is the
 * single source Rust and the frontend read at runtime (see src/lib/authIdentity.ts), so nothing else
 * repeats the scheme. Production has no tag and uses src-tauri/tauri.conf.json unchanged.
 *
 *   node scripts/qa-build-identity.mjs 1015 [--out /path/overlay.json]
 *
 * Supabase must allow `lecturecompanion-qa*://auth-callback` (one narrow wildcard; never `*`/`**`).
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TAG = /^[a-z0-9]{1,16}$/

export function deriveQaBuildIdentity(tag) {
  if (typeof tag !== 'string' || !TAG.test(tag)) throw new Error('invalid_qa_tag')
  return {
    tag,
    productName: `Youmi Lens QA ${tag}`,
    identifier: `com.youmilens.desktop.qa${tag}`,
    scheme: `lecturecompanion-qa${tag}`,
    callback: `lecturecompanion-qa${tag}://auth-callback`,
  }
}

export function qaConfigOverlay(tag) {
  const id = deriveQaBuildIdentity(tag)
  return {
    productName: id.productName,
    identifier: id.identifier,
    plugins: { 'deep-link': { desktop: { schemes: [id.scheme] } } },
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [tag, flag, out] = process.argv.slice(2)
  const json = JSON.stringify(qaConfigOverlay(tag), null, 2) + '\n'
  if (flag === '--out' && out) writeFileSync(out, json)
  else process.stdout.write(json)
}
