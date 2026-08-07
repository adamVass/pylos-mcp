import { describe, expect } from 'vitest'
import { ImapSession } from '../../src/core/client.js'
import { ToolError } from '../../src/errors.js'
import { testConfig, itIntegration } from './helpers.js'

describe('ImapSession against a local Dovecot container', () => {
  itIntegration('connects over TLS and lists folders', async () => {
    const s = new ImapSession(testConfig())
    try {
      const folders = await s.withClient(async (c) => c.list())
      expect(folders.map((f) => f.path)).toContain('INBOX')
    } finally {
      await s.close()
    }
  })

  itIntegration('finds special-use Drafts and Trash', async () => {
    const s = new ImapSession(testConfig())
    try {
      expect(await s.specialUse('\\Drafts', 'Drafts')).toBe('Drafts')
      expect(await s.specialUse('\\Trash', 'Trash')).toBe('Trash')
    } finally {
      await s.close()
    }
  })

  // the assertions above pass whether special-use was discovered or the fallback
  // was returned, so these prove discovery actually happened
  itIntegration('discovers special-use from the server, not from the fallback', async () => {
    const s = new ImapSession(testConfig())
    try {
      const folders = await s.withClient(async (c) => c.list())
      expect(folders.find((f) => f.specialUse === '\\Drafts')?.path).toBe('Drafts')
      expect(folders.find((f) => f.specialUse === '\\Trash')?.path).toBe('Trash')
      expect(await s.specialUse('\\Drafts', 'FALLBACK_NOT_USED')).toBe('Drafts')
    } finally {
      await s.close()
    }
  })

  itIntegration('falls back when no folder carries the flag', async () => {
    const s = new ImapSession(testConfig())
    try {
      // \Archive is used only because the harness deliberately has no folder
      // carrying it, which is the one way to exercise the fallback branch against
      // a real server. The cast is because the declared parameter type is narrowed
      // to the two flags production code needs.
      const folders = await s.withClient(async (c) => c.list())
      expect(folders.some((f) => f.specialUse === '\\Archive')).toBe(false)
      expect(await s.specialUse('\\Archive' as '\\Trash', 'Archive')).toBe('Archive')
    } finally {
      await s.close()
    }
  })

  itIntegration('withMailbox opens INBOX and releases the lock', async () => {
    const s = new ImapSession(testConfig())
    try {
      const path = await s.withMailbox('INBOX', async (c) => c.mailbox && c.mailbox.path)
      expect(path).toBe('INBOX')
      // a leaked lock would deadlock this second call
      const again = await s.withMailbox('INBOX', async (c) => c.mailbox && c.mailbox.path)
      expect(again).toBe('INBOX')
    } finally {
      await s.close()
    }
  })

  itIntegration('withMailbox on a missing folder → ToolError code not_found', async () => {
    const s = new ImapSession(testConfig())
    try {
      const err = await s.withMailbox('NoSuchFolderHere', async () => undefined).catch((e) => e)
      expect(err).toBeInstanceOf(ToolError)
      expect((err as ToolError).code).toBe('not_found')
    } finally {
      await s.close()
    }
  })

  itIntegration('wrong password → ToolError code auth, message contains no password', async () => {
    const s = new ImapSession(testConfig({ EMAIL_PASSWORD: 'wrong-secret-xyz' }))
    const err = await s.withClient(async () => undefined).catch((e) => e)
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).code).toBe('auth')
    expect((err as ToolError).message).not.toContain('wrong-secret-xyz')
    await s.close()
  })

  itIntegration('nothing listening → ToolError code connect naming host:port only', async () => {
    const s = new ImapSession(testConfig({ IMAP_PORT: '10894' }))
    const err = await s.withClient(async () => undefined).catch((e) => e)
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).code).toBe('connect')
    expect((err as ToolError).message).toContain('localhost:10894')
    expect((err as ToolError).message).not.toContain('testpass')
    await s.close()
  })

  itIntegration('untrusted certificate is rejected — no verification bypass', async () => {
    // same server, but without the test CA added as a trust anchor
    const s = new ImapSession(testConfig({ TLS_CA_FILE: undefined }))
    const err = await s.withClient(async () => undefined).catch((e) => e)
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).code).toBe('connect')
    // discriminates a certificate rejection from any other connect failure
    expect((err as ToolError).message).toContain('TLS certificate')
    await s.close()
  })

  itIntegration('reuses one connection across calls', async () => {
    const s = new ImapSession(testConfig())
    try {
      const a = await s.withClient(async (c) => c)
      const b = await s.withClient(async (c) => c)
      expect(a).toBe(b)
    } finally {
      await s.close()
    }
  })

  itIntegration('reconnects after the connection is lost', async () => {
    const s = new ImapSession(testConfig())
    try {
      const a = await s.withClient(async (c) => c)
      a.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const b = await s.withClient(async (c) => c)
      expect(b).not.toBe(a)
      expect((await s.withClient(async (c) => c.list())).map((f) => f.path)).toContain('INBOX')
    } finally {
      await s.close()
    }
  })

  itIntegration('close() is safe to call twice and when never connected', async () => {
    const s = new ImapSession(testConfig())
    await s.close()
    await s.withClient(async (c) => c.list())
    await s.close()
    await s.close()
  })
})
