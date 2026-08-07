import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { makeCoreApi } from '../../src/core/api.js'
import { ImapSession } from '../../src/core/client.js'
import { getSieveScript, listSieveScripts } from '../../src/core/sieve.js'
import { ToolError } from '../../src/errors.js'
import { renderSieveList, renderSieveScript } from '../../src/safety/render.js'
import { itIntegration, testCaFile, testConfig } from './helpers.js'

// The first describe below talks to the Dovecot container run.sh starts, which
// also seeds the two scripts these tests read: "filters" (active) and "bulky"
// (deliberately larger than a 1 kB body cap).

const SEEDED = 'filters'
const OVERSIZED = 'bulky'

function sieveConfig(overrides: Record<string, string | undefined> = {}) {
  return testConfig({ CAPABILITIES: 'sieve-read', ...overrides })
}

/**
 * The kb argument has to match the MAX_BODY_KB the script was read under,
 * because the renderer is what truncates.
 */
function scriptText(content: Awaited<ReturnType<typeof getSieveScript>>, maxBodyKb = 64): string {
  return renderSieveScript('n', content, maxBodyKb)
}

describe('the ManageSieve client', () => {
  itIntegration('lists scripts and marks the active one', async () => {
    const scripts = await listSieveScripts(sieveConfig())
    const rendered = renderSieveList(scripts)

    expect(rendered).toContain(`${SEEDED} (active)`)
    // the second seeded script is NOT marked active, so the marker is proven to
    // come from the server's ACTIVE suffix rather than from every row
    expect(rendered).toContain(`${OVERSIZED}\n`)
    expect(rendered).not.toContain(`${OVERSIZED} (active)`)
  })

  itIntegration('fetches script content from the literal the server sends', async () => {
    const content = await getSieveScript(sieveConfig(), SEEDED)
    expect(scriptText(content)).toContain('fileinto')
  })

  itIntegration('caps script content at the body limit rather than returning it whole', async () => {
    const content = await getSieveScript(sieveConfig({ MAX_BODY_KB: '1' }), OVERSIZED)
    const rendered = scriptText(content, 1)

    expect(rendered).toContain('[truncated at 1 kB]')
    // the client never held more than a kilobyte of slack past the cap either
    expect(rendered.length).toBeLessThan(2000)
  })

  itIntegration('reports an unknown script name as not_found', async () => {
    const error = await getSieveScript(sieveConfig(), 'no-such-script').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe('not_found')
  })

  itIntegration('S-1 regression: an auth failure names no credential material', async () => {
    const password = 'sekrit-value'
    const cfg = sieveConfig({ EMAIL_PASSWORD: password })

    const error = await listSieveScripts(cfg).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe('auth')

    const message = (error as ToolError).message
    expect(message).not.toContain(password)
    expect(message).not.toContain(Buffer.from(`\0tester\0${password}`).toString('base64'))
    // nor the server's own refusal text, which is attacker-controllable
    expect(message).not.toMatch(/authentication failed\./i)
    expect(message.toLowerCase()).not.toContain('dovecot')
  })

  itIntegration('the CoreApi seam reaches the real client', async () => {
    const cfg = sieveConfig()
    const core = makeCoreApi(cfg, new ImapSession(cfg))

    expect(renderSieveList(await core.listSieveScripts())).toContain(SEEDED)
    expect(scriptText(await core.getSieveScript(SEEDED))).toContain('fileinto')
  })
})

// The cases below need Docker for nothing: what they pin is what the client
// refuses to do, which takes a server that misbehaves rather than a correct one.
// They share the certificate run.sh generates for the container.

const certDir = dirname(testCaFile)

function ensureCerts(): void {
  if (existsSync(testCaFile)) return
  execFileSync('bash', [join(certDir, '..', 'gen-certs.sh')], { stdio: 'inherit' })
}

/** everything a real greeting has, minus whichever capability the case is about */
function greeting(capabilities: string[]): string {
  return [
    '"IMPLEMENTATION" "Fake Sieve"',
    '"SASL" "PLAIN"',
    ...capabilities.map((c) => `"${c}"`),
    '"VERSION" "1.0"',
    'OK "Fake ready."',
    '',
  ].join('\r\n')
}

async function listenOnAnyPort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('a sieve server that stalls during the TLS upgrade', () => {
  let server: Server | undefined
  let port = 0
  const connections: Socket[] = []

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    server = createServer((socket: Socket) => {
      connections.push(socket)
      socket.on('error', () => undefined)
      socket.write(greeting(['STARTTLS']))
      socket.once('data', () => {
        // agrees to the upgrade, then never speaks again: no handshake, no close,
        // so nothing but a timer can end this
        socket.write('OK "Begin TLS negotiation now."\r\n')
      })
    })
    port = await listenOnAnyPort(server)
  })

  afterAll(async () => {
    for (const socket of connections) socket.destroy()
    await closeServer(server)
  })

  // The socket timeout is 10 s and is not injectable, so this case costs real
  // wall-clock time. The defect it pins is a call that never returns at all,
  // which no shorter test can distinguish from a slow one.
  itIntegration(
    'gives up on the timeout instead of hanging forever',
    async () => {
      const startedAt = Date.now()
      const error = await listSieveScripts(sieveConfig({ SIEVE_PORT: String(port) })).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe('connect')
      expect(Date.now() - startedAt).toBeLessThan(20_000)
    },
    30_000,
  )
})

describe('a sieve server that streams more than the client will read', () => {
  let server: Server | undefined
  let port = 0
  let streamed = 0

  // Far past anything the client should accept, and a hard stop so a failing
  // run cannot fill memory before the assertion gets to speak.
  const CHUNK = Buffer.alloc(64 * 1024, 0x61)
  const HARD_STOP = 60_000_000

  function streamForever(secure: TLSSocket): void {
    secure.write(`{${HARD_STOP * 2}}\r\n`)
    const pump = (): void => {
      while (secure.writable && streamed < HARD_STOP) {
        streamed += CHUNK.length
        if (!secure.write(CHUNK)) return // resumes on drain, so the client sets the pace
      }
    }
    secure.on('drain', pump)
    pump()
  }

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return
    ensureCerts()

    const key = readFileSync(join(certDir, 'key.pem'))
    const cert = readFileSync(join(certDir, 'cert.pem'))

    // allowHalfOpen, because a polite server that stops writing the moment the
    // client half-closes would hide the defect entirely
    server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      socket.on('error', () => undefined)
      socket.write(greeting(['STARTTLS']))
      socket.once('data', () => {
        socket.write('OK "Begin TLS negotiation now."\r\n')

        // no allowHalfOpen here: TLSSocket takes it from the socket it wraps and
        // ignores its own, so the createServer option above is what matters
        const secure = new TLSSocket(socket, { isServer: true, key, cert })
        secure.on('error', () => undefined)
        secure.once('secure', () => secure.write(greeting([])))
        secure.on('data', (chunk: Buffer) => {
          const command = chunk.toString('utf8')
          if (command.startsWith('AUTHENTICATE')) secure.write('OK "Logged in."\r\n')
          if (command.startsWith('GETSCRIPT')) streamForever(secure)
        })
      })
    })
    port = await listenOnAnyPort(server)
  })

  afterAll(() => closeServer(server))

  itIntegration(
    'drops the connection rather than reading past the cap',
    async () => {
      const cfg = sieveConfig({ SIEVE_PORT: String(port), MAX_BODY_KB: '1' })
      const content = await getSieveScript(cfg, 'endless')
      expect(scriptText(content, 1)).toContain('[truncated at 1 kB]')

      const atReturn = streamed
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // A connection left open with the reader still attached goes on consuming at
      // tens of megabytes a second, and the inactivity timeout never fires because
      // the peer is the busy one.
      expect(streamed - atReturn).toBeLessThan(5_000_000)
    },
    15_000,
  )
})
