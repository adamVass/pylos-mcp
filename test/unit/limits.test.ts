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
  // a body of invalid bytes decodes to U+FFFD, which once made the tail cleanup quadratic
  it('cuts a long run of replacement characters in linear time, keeping the ones the text had', () => {
    const text = '\uFFFD'.repeat(21_300) + 'x'.repeat(2000)
    const started = performance.now()
    const out = truncateAtKb(text, 64)
    expect(performance.now() - started).toBeLessThan(200)
    expect(out).toBe(`${text.slice(0, 21_300 + 100)}\n[truncated at 64 kB]`)
  })
  it('drops a character the cut split in half', () => {
    expect(truncateAtKb(`a${'é'.repeat(10)}`, 0.01)).toBe(`a${'é'.repeat(4)}\n[truncated at 0.01 kB]`)
  })
})
