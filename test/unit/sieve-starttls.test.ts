import { createServer, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { listSieveScripts } from '../../src/core/sieve.js'
import { ToolError } from '../../src/errors.js'

// The refusal happens on the greeting, before any TLS upgrade is attempted, so
// there is nothing here for a container or a certificate to provide.

/** everything a real ManageSieve greeting has, minus STARTTLS */
const GREETING_WITHOUT_STARTTLS = [
  '"IMPLEMENTATION" "Fake Sieve"',
  '"SASL" "PLAIN"',
  '"VERSION" "1.0"',
  'OK "Fake ready."',
  '',
].join('\r\n')

describe('a sieve server that does not offer STARTTLS', () => {
  let server: Server
  let port = 0
  let received = ''

  beforeAll(async () => {
    server = createServer((socket: Socket) => {
      socket.on('error', () => undefined)
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
      })
      socket.write(GREETING_WITHOUT_STARTTLS)
    })

    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('is refused before a single credential byte is written', async () => {
    received = ''
    const cfg = loadConfig({
      EMAIL_USER: 'tester',
      EMAIL_PASSWORD: 'testpass',
      IMAP_HOST: 'localhost',
      CAPABILITIES: 'sieve-read',
      SIEVE_HOST: '127.0.0.1',
      SIEVE_PORT: String(port),
    })

    const error = await listSieveScripts(cfg).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe('connect')
    expect((error as ToolError).message).toMatch(/STARTTLS/)

    // nothing was sent at all, so no AUTHENTICATE line and no base64 credential
    // could have reached a server willing to read it in the clear
    expect(received).not.toMatch(/AUTHENTICATE/i)
    expect(received).toBe('')
  })
})
