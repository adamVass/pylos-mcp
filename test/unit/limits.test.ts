import { describe, it, expect } from 'vitest'
import { truncateAtKb } from '../../src/safety/limits.js'

describe('truncateAtKb', () => {
  it('passes short text through unchanged', () => {
    expect(truncateAtKb('hello', 64)).toBe('hello')
  })
  it('truncates at the byte limit with an explicit marker', () => {
    const out = truncateAtKb('a'.repeat(3000), 2)
    expect(Buffer.byteLength(out)).toBeLessThan(2100)
    expect(out.endsWith('\n[truncated at 2 kB]')).toBe(true)
  })
  it('never splits a multi-byte character', () => {
    const out = truncateAtKb('é'.repeat(2000), 2) // 2 bytes each in UTF-8
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(out.replace(/\n\[truncated at 2 kB\]$/, ''))),
    ).not.toThrow()
  })
})
