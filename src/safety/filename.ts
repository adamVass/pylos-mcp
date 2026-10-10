import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { INVISIBLE_CLASS } from './invisible.js'

// The range is 0x00-0x1F wholesale, unlike html.ts which spares \t\n\r: a
// filename has no line structure to preserve. U+0085 NEL is here for the same
// reason.
const UNSAFE_CHARS = new RegExp(`[\\x00-\\x1F\\x7F\\u0085${INVISIBLE_CLASS}]`, 'gu')
const RESERVED_CHARS = /[:*?"<>|]/g

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  let cleaned = fitLength(base.replace(UNSAFE_CHARS, '').replace(RESERVED_CHARS, '_').replaceAll('![', '!［'))

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

// Filesystems cap a name near 255 bytes, and uniquePath may still append -N.
const MAX_NAME_BYTES = 200
const MAX_EXT_BYTES = 16

function fitLength(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name

  const ext = extname(name)
  const kept = Buffer.byteLength(ext) <= MAX_EXT_BYTES ? ext : ''
  const budget = MAX_NAME_BYTES - Buffer.byteLength(kept)
  let stem = ''
  for (const char of name.slice(0, name.length - kept.length)) {
    if (Buffer.byteLength(stem + char) > budget) break
    stem += char
  }
  return stem + kept
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
