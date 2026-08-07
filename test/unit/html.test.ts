import { it, expect } from 'vitest'
import { htmlToPlainText, stripInvisible } from '../../src/safety/html.js'
it('converts basic HTML to readable text', () => {
  expect(htmlToPlainText('<p>Hello <b>world</b></p>')).toContain('Hello world')
})
it('drops script and style content', () => {
  const out = htmlToPlainText('<style>.x{}</style><script>evil()</script><p>ok</p>')
  expect(out).not.toContain('evil')
  expect(out).not.toContain('.x{}')
  expect(out).toContain('ok')
})
it('stripInvisible removes zero-width and bidi-override characters', () => {
  expect(stripInvisible('a​b‮c﻿d⁠e')).toBe('abcde')
})
