import { describe, it, expect } from 'vitest'
import { makeUntrusted, readUntrusted, UntrustedText } from '../../src/safety/untrusted.js'

describe('UntrustedText', () => {
  it('round-trips via readUntrusted', () => {
    expect(readUntrusted(makeUntrusted('hi'))).toBe('hi')
  })
  it('cannot be coerced into output text', () => {
    const t = makeUntrusted('payload')
    expect(() => `${t}`).toThrow()
    expect(() => JSON.stringify({ t })).toThrow()
    expect(t instanceof UntrustedText).toBe(true)
  })
})
