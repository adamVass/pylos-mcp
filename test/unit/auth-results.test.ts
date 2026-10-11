import { describe, expect, it } from 'vitest'
import { trustedDmarcFailed } from '../../src/core/auth-results.js'

const block = (...lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)

// Adam's Microsoft 365 mail, 2026-10-11, addresses removed
const MICROSOFT =
  'Authentication-Results: mx.microsoft.com 1; spf=fail (sender IP is 192.0.2.1) smtp.mailfrom=em.example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100'
// Adam's mailbox.org mail, 2026-10-11, addresses removed
const MAILBOX_ORG =
  'Authentication-Results: incoming_mbo; dkim=pass header.d=example.com header.s=xq header.b=abc; spf=pass (incoming_mbo: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com; dmarc=pass (policy=quarantine) header.from=example.com'

describe('trustedDmarcFailed', () => {
  it('reads the trusted header past its version token', () => {
    expect(trustedDmarcFailed(block(MICROSOFT), ['mx.microsoft.com'])).toBe(false)
    expect(trustedDmarcFailed(block(MICROSOFT.replace('dmarc=pass', 'dmarc=fail')), ['mx.microsoft.com'])).toBe(true)
    expect(trustedDmarcFailed(block(MAILBOX_ORG.replace('dmarc=pass', 'DMARC=FAIL')), ['incoming_mbo'])).toBe(true)
  })

  it('ignores an untrusted header on top, and is false with no trusted header', () => {
    const forged = 'Authentication-Results: evil.example; dmarc=fail header.from=example.com'
    expect(trustedDmarcFailed(block(forged, MAILBOX_ORG), ['incoming_mbo'])).toBe(false)
    expect(trustedDmarcFailed(block(forged), ['incoming_mbo'])).toBe(false)
    expect(trustedDmarcFailed(block('Subject: hi'), [])).toBe(false)
  })

  it('a forged trusted header below the real one cannot change the answer', () => {
    const real = 'Authentication-Results: incoming_mbo; dmarc=fail header.from=example.com'
    const forged = 'Authentication-Results: incoming_mbo; dmarc=pass header.from=example.com'
    expect(trustedDmarcFailed(block(real, 'Received: from x', forged), ['incoming_mbo'])).toBe(true)
  })

  it('takes DMARC from a later trusted header when the first carries none', () => {
    const dkimOnly = 'Authentication-Results: posteo.de; dkim=pass header.d=example.com'
    const dmarc = 'Authentication-Results: posteo.de; dmarc=fail (p=reject dis=none) header.from=example.com'
    expect(trustedDmarcFailed(block(dkimOnly, dmarc), ['posteo.de'])).toBe(true)
  })

  it('a suffix entry matches the provider domain only', () => {
    const at = (id: string) => block(`Authentication-Results: ${id}; dmarc=fail header.from=example.com`)
    expect(trustedDmarcFailed(at('mx6.messagingengine.com'), ['.messagingengine.com'])).toBe(true)
    expect(trustedDmarcFailed(at('messagingengine.com.evil.example'), ['.messagingengine.com'])).toBe(false)
    expect(trustedDmarcFailed(at('evilmessagingengine.com'), ['.messagingengine.com'])).toBe(false)
  })

  it('comments, folding, renamed headers and broken parentheses never fake a failure', () => {
    const inComment =
      'Authentication-Results: incoming_mbo; spf=pass (looks like; dmarc=fail) smtp.mailfrom=x; dmarc=pass'
    expect(trustedDmarcFailed(block(inComment), ['incoming_mbo'])).toBe(false)
    const folded =
      'Authentication-Results: incoming_mbo; spf=pass\r\n\tsmtp.mailfrom=x;\r\n dmarc=fail header.from=example.com'
    expect(trustedDmarcFailed(block(folded), ['incoming_mbo'])).toBe(true)
    const renamed = 'Authentication-Results-Original: incoming_mbo; dmarc=fail header.from=example.com'
    expect(trustedDmarcFailed(block(renamed), ['incoming_mbo'])).toBe(false)
    const unbalanced = 'Authentication-Results: incoming_mbo; spf=pass (never closed; dmarc=fail'
    expect(trustedDmarcFailed(block(unbalanced), ['incoming_mbo'])).toBe(false)
  })

  it('quoted strings and escaped parentheses in sender-chosen values change nothing', () => {
    const at = (rest: string) => block(`Authentication-Results: mx.google.com; ${rest}`)
    const ids = ['mx.google.com']
    expect(
      trustedDmarcFailed(
        at('spf=pass (domain of "x;dmarc=fail"@evil.example) smtp.mailfrom="x;dmarc=fail"@evil.example; dmarc=pass'),
        ids,
      ),
    ).toBe(false)
    expect(
      trustedDmarcFailed(at('spf=pass (domain of x\\);dmarc=fail;\\(@evil.example) smtp.mailfrom=x; dmarc=pass'), ids),
    ).toBe(false)
    expect(
      trustedDmarcFailed(at('spf=pass smtp.mailfrom="x("@evil.example; dmarc=fail header.from=example.com'), ids),
    ).toBe(true)
    expect(trustedDmarcFailed(at('spf=pass (domain of x\\(@evil.example) smtp.mailfrom=x; dmarc=fail'), ids)).toBe(true)
  })
})
