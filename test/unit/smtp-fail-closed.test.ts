import { afterAll, beforeAll, it, expect } from 'vitest'
import { SMTPServer } from 'smtp-server'
import { loadConfig } from '../../src/config.js'
import { ComposeBudget } from '../../src/core/draft.js'
import { SendState, sendEmail } from '../../src/core/smtp.js'
import { ToolError } from '../../src/errors.js'
import type { ImapSession } from '../../src/core/client.js'

/**
 * The fail-closed half of the send path: a relay that will not upgrade to TLS
 * must make the send fail, never fall back to a cleartext session. A unit test
 * rather than an integration one because with STARTTLS hidden TLS never begins,
 * so no certificate is involved.
 */

const USER = 'tester@x.example'
const ALLOWED = 'a@x.example'

const delivered: string[] = []
let server: SMTPServer
let port = 0

beforeAll(async () => {
  server = new SMTPServer({
    secure: false,
    // Everything else about this server is permissive on purpose: it accepts any
    // credentials and any recipient, so "nothing was delivered" can only mean the
    // client refused, never that the server did.
    hideSTARTTLS: true,
    authOptional: true,
    logger: false,
    onAuth(auth, _session, callback) {
      callback(null, { user: auth.username })
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        delivered.push(Buffer.concat(chunks).toString('utf8'))
        callback()
      })
    },
  })

  port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** never connected: a send without attachments must not touch IMAP at all */
const idleSession = {} as ImapSession

it('a relay that will not do STARTTLS fails the send instead of delivering in the clear', async () => {
  const cfg = loadConfig({
    EMAIL_USER: USER,
    EMAIL_PASSWORD: 'testpass',
    IMAP_HOST: 'localhost',
    CAPABILITIES: 'send',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    // set only so the send reaches the TLS check rather than being refused first
    // by the closed-by-default allowlist
    SEND_ALLOWLIST: ALLOWED,
  })
  const state = new SendState()

  const error = await sendEmail(
    idleSession,
    cfg,
    state,
    {
      to: [ALLOWED],
      subject: 'must not go out in the clear',
      body: 'secret',
    },
    new ComposeBudget(),
  ).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(ToolError)

  // the message never reached a server willing to take it unencrypted, and the
  // budget was not spent on it
  expect(delivered).toEqual([])
  expect(state.sent).toBe(0)
  expect(state.inFlight).toBe(0)

  expect((error as ToolError).message).not.toContain('secret')
  expect((error as ToolError).message).toMatch(/TLS|SMTP connection/i)
})
