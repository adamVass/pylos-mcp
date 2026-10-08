import { it, expect } from 'vitest'
import { htmlToPlainText } from '../../src/safety/html.js'
it('drops script and style content', () => {
  const out = htmlToPlainText('<style>.x{}</style><script>evil()</script><p>ok</p>')
  expect(out).not.toContain('evil')
  expect(out).not.toContain('.x{}')
  expect(out).toContain('ok')
})
