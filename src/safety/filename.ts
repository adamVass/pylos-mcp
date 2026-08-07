import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { INVISIBLE_CLASS } from './invisible.js'

// The range is 0x00-0x1F wholesale, unlike html.ts which spares \t\n\r: a
// filename has no line structure to preserve. U+0085 NEL is here for the same
// reason, and because the saved path is rendered outside the fence.
const UNSAFE_CHARS = new RegExp(`[\\x00-\\x1F\\x7F\\u0085${INVISIBLE_CLASS}]`, 'gu')
const RESERVED_CHARS = /[:*?"<>|]/g

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  let cleaned = base.replace(UNSAFE_CHARS, '').replace(RESERVED_CHARS, '_')

  // Trim and strip leading dots to a fixpoint. A single pass in either order is
  // not enough: dot-strip-then-trim leaves a leading space blocking the `/^\.+/`
  // anchor, so the trailing trim re-exposes the dots it should have removed
  // (' .hidden' -> '.hidden'). Looping handles arbitrary interleaving.
  let previous: string
  do {
    previous = cleaned
    cleaned = cleaned.trim().replace(/^\.+/, '')
  } while (cleaned !== previous)

  return cleaned === '' ? 'attachment' : cleaned
}

export function uniquePath(dir: string, filename: string): string {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)

  let candidate = resolve(join(dir, filename))
  let n = 0
  while (existsSync(candidate)) {
    n += 1
    candidate = resolve(join(dir, `${stem}-${n}${ext}`))
  }
  return candidate
}
