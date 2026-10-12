import { createServer, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { ImapSession } from '../../src/core/client.js'
import { ToolError } from '../../src/errors.js'
import { listenOnAnyPort } from './helpers.js'

// The refusal happens on the greeting, before any TLS upgrade is attempted, so
// there is nothing here for a container or a certificate to provide.

describe('an IMAP server that does not offer STARTTLS', () => {
  let server: Server
  let port = 0
  let received = ''

  beforeAll(async () => {
    server = createServer((socket: Socket) => {
      socket.on('error', () => undefined)
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
        // answer anything with the same capabilities, still without STARTTLS
        for (const tag of received.match(/^\S+(?= )/gm) ?? []) {
          socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`)
        }
      })
      socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Fake ready\r\n')
    })

    port = await listenOnAnyPort(server)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('is refused before the login is written', async () => {
    received = ''
    const session = new ImapSession(
      loadConfig({
        EMAIL_USER: 'tester',
        EMAIL_PASSWORD: 'testpass',
        IMAP_HOST: '127.0.0.1',
        IMAP_PORT: String(port),
        IMAP_STARTTLS: 'true',
      }),
    )

    const error = await session.withClient(async () => 'unreached').catch((e: unknown) => e)
    await session.close()

    expect(error).toEqual(
      new ToolError(
        'connect',
        '127.0.0.1:' +
          port +
          ' did not switch to TLS with STARTTLS, so no login was sent. Check IMAP_PORT, or unset IMAP_STARTTLS for a server that uses TLS from the first byte',
      ),
    )
    expect(received).not.toMatch(/LOGIN|AUTHENTICATE/i)
    expect(received).not.toContain('testpass')
  })
})
