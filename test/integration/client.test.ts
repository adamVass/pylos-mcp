import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
import { ImapFlow } from 'imapflow'
import { describe, expect, vi } from 'vitest'
import { ImapSession } from '../../src/core/client.js'
import { ToolError } from '../../src/errors.js'
import { testConfig, itIntegration, testCaFile } from './helpers.js'

const SOH = String.fromCharCode(1)

/**
 * Dovecot offers no XOAUTH2, and imapflow never attempts it against a server
 * that does not advertise it, so this refusal comes from a fake answering just
 * enough IMAP for one login attempt.
 */
async function refusingXoauth2Server() {
  const attempts: string[] = []
  const certDir = dirname(testCaFile)
  const server = createTlsServer(
    { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    (socket) => {
      socket.on('error', () => {})
      socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2] ready\r\n')
      let buffered = ''
      socket.on('data', (chunk) => {
        buffered += chunk
        for (let end = buffered.indexOf('\r\n'); end !== -1; end = buffered.indexOf('\r\n')) {
          const [tag, command = '', ...args] = buffered.slice(0, end).split(' ')
          buffered = buffered.slice(end + 2)
          if (command.toUpperCase() === 'AUTHENTICATE') {
            attempts.push(`${args[0]} ${Buffer.from(args[1] ?? '', 'base64').toString('utf8')}`)
            socket.write(`${tag} NO [AUTHENTICATIONFAILED] AUTHENTICATE failed\r\n`)
          } else if (command.toUpperCase() === 'CAPABILITY') {
            socket.write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK done\r\n`)
          } else {
            socket.write(`${tag} BAD unsupported\r\n`)
          }
        }
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    attempts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('ImapSession against a local Dovecot container', () => {
  // the attempt pins that imapflow got the access token and no password
  itIntegration('a token the server refuses was sent as XOAUTH2, and is forgotten', async () => {
    const fake = await refusingXoauth2Server()
    let forgotten = 0
    const tokens = {
      accessToken: async () => 'not-a-token',
      forget: async () => {
        forgotten += 1
      },
    }
    const s = new ImapSession(
      testConfig({ PROVIDER: 'outlook', EMAIL_PASSWORD: undefined, IMAP_PORT: String(fake.port) }),
      tokens,
    )
    try {
      await expect(s.withClient(async () => 'unreached')).rejects.toThrow(
        new ToolError(
          'auth',
          'Microsoft refused the sign-in for EMAIL_USER. Either the browser sign-in used another account, or IMAP is turned off for this mailbox. On Outlook.com, turn it on under Settings, Mail, Forwarding and IMAP. On work accounts an administrator turns it on. Then ask again to sign in afresh.',
        ),
      )
      expect(fake.attempts).toEqual([`XOAUTH2 user=tester${SOH}auth=Bearer not-a-token${SOH}${SOH}`])
      expect(forgotten).toBe(1)
    } finally {
      await s.close()
      await fake.close()
    }
  })

  itIntegration('connects over TLS and lists folders', async () => {
    const s = new ImapSession(testConfig())
    try {
      const folders = await s.withClient(async (c) => c.list())
      expect(folders.map((f) => f.path)).toContain('INBOX')
    } finally {
      await s.close()
    }
  })

  itIntegration('connects with STARTTLS on the plaintext port, verifying the certificate', async () => {
    const s = new ImapSession(
      testConfig({ IMAP_STARTTLS: 'true', IMAP_PORT: process.env.PYLOS_IMAP_STARTTLS_PORT ?? '10143' }),
    )
    try {
      const folders = await s.withClient(async (c) => c.list())
      expect(folders.map((f) => f.path)).toContain('INBOX')
    } finally {
      await s.close()
    }
  })

  itIntegration('an untrusted certificate after STARTTLS is rejected too', async () => {
    const s = new ImapSession(
      testConfig({
        IMAP_STARTTLS: 'true',
        IMAP_PORT: process.env.PYLOS_IMAP_STARTTLS_PORT ?? '10143',
        TLS_CA_FILE: undefined,
      }),
    )
    const err = await s.withClient(async () => undefined).catch((e) => e)
    await s.close()
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).message).toContain('TLS certificate')
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

  itIntegration('looks up Drafts and Sent once per connection, and Trash every time', async () => {
    const s = new ImapSession(testConfig())
    try {
      const list = vi.spyOn(await s.withClient(async (c) => c), 'list')
      await s.specialUse('\\Drafts', 'Drafts')
      await s.specialUse('\\Drafts', 'Drafts')
      expect(list).toHaveBeenCalledTimes(1)
      // Trash decides what the delete tier may touch, so it is never served from memory
      await s.specialUse('\\Trash', 'Trash')
      await s.specialUse('\\Trash', 'Trash')
      expect(list).toHaveBeenCalledTimes(3)
    } finally {
      await s.close()
    }
  })

  itIntegration('a lost connection drops the remembered folders before the next lookup', async () => {
    const s = new ImapSession(testConfig())
    const list = vi.spyOn(ImapFlow.prototype, 'list')
    try {
      await s.specialUse('\\Drafts', 'Drafts')
      ;(await s.withClient(async (c) => c)).close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await s.specialUse('\\Drafts', 'Drafts')
      expect(list).toHaveBeenCalledTimes(2)
    } finally {
      list.mockRestore()
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
