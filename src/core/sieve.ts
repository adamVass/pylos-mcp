// A ManageSieve client (RFC 5804) with exactly the two commands the read-only
// tier needs. Two invariants govern every line of it:
//
//   * STARTTLS completes before a single authentication byte is written, and a
//     server that does not offer it is refused outright, so credentials cannot
//     be talked out of this client by a downgrade.
//   * No message this file raises carries server text or credential material.
//     Nothing here logs, either: the AUTHENTICATE line must not reach a log file
//     any more than it may reach the model.

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Config } from '../config.js'
import { APP_PASSWORD_ADVICE, TLS_CA_ADVICE, ToolError } from '../errors.js'
import { readLimitBytes } from '../safety/limits.js'
import { makeUntrusted, type UntrustedText } from '../safety/untrusted.js'
import { secureOptions } from './tls.js'

const TIMEOUT_MS = 10_000

// Bounds on what a server can make this client hold or loop over. Dovecot caps a
// ManageSieve line at 64 kB, and the others exist so a server that never sends
// its final OK fails fast instead of spinning until the socket timeout.
const MAX_LINE_BYTES = 64 * 1024
const MAX_CAPABILITY_LINES = 64
const MAX_SCRIPTS = 1000

interface Target {
  host: string
  port: number
}

export interface SieveScriptEntry {
  name: UntrustedText
  active: boolean
}

export async function listSieveScripts(cfg: Config): Promise<SieveScriptEntry[]> {
  const conn = await authenticated(cfg)
  try {
    return await readScriptList(conn)
  } finally {
    conn.close()
  }
}

export interface SieveScript {
  content: UntrustedText
  cutShort: boolean
}

export async function getSieveScript(cfg: Config, name: string): Promise<SieveScript> {
  // interpolated into a protocol command below, so a line break would let a
  // caller append a command of their own
  if (/[\r\n\0]/.test(name)) {
    throw new ToolError('policy', 'a sieve script name cannot contain a line break')
  }

  const conn = await authenticated(cfg)
  try {
    return await readScript(conn, name, cfg.maxBodyKb)
  } finally {
    conn.close()
  }
}

/**
 * The order is the whole security property: the STARTTLS check happens against
 * the plaintext greeting and returns before any command follows it.
 */
async function authenticated(cfg: Config): Promise<SieveConnection> {
  const target = sieveTarget(cfg)
  const conn = await SieveConnection.open(target)

  try {
    const capabilities = await conn.readCapabilities()
    if (!capabilities.has('STARTTLS')) {
      throw new ToolError(
        'connect',
        `the sieve server at ${target.host}:${target.port} does not offer STARTTLS. Refusing to continue`,
      )
    }

    conn.write('STARTTLS\r\n')
    if (!isOk(await conn.readLine())) {
      throw new ToolError(
        'connect',
        `the sieve server at ${target.host}:${target.port} refused to start TLS. Refusing to continue`,
      )
    }

    await conn.upgrade(cfg)
    await conn.readCapabilities()
    await conn.authenticate(cfg.user, cfg.password)
    return conn
  } catch (err) {
    // no LOGOUT: the session never became one, and a failure here must not be
    // able to block on a server that has stopped answering
    conn.destroy()
    throw err
  }
}

function sieveTarget(cfg: Config): Target {
  if (!cfg.sieve) throw new ToolError('server', 'Sieve is not configured. Set SIEVE_HOST or PROVIDER')
  return cfg.sieve
}

async function readScriptList(conn: SieveConnection): Promise<SieveScriptEntry[]> {
  conn.write('LISTSCRIPTS\r\n')

  const scripts: SieveScriptEntry[] = []
  for (let i = 0; i < MAX_SCRIPTS; i++) {
    const line = await conn.readLine()
    if (isOk(line)) return scripts
    if (isFailure(line)) throw new ToolError('server', 'the sieve server refused to list the scripts')

    const quoted = parseQuoted(line)
    if (!quoted) throw conn.unparseable()
    scripts.push({
      name: makeUntrusted(quoted.value),
      active: quoted.rest.trim().toUpperCase() === 'ACTIVE',
    })
  }
  throw conn.unparseable()
}

/**
 * GETSCRIPT answers with a literal: `{N}` on its own line, then exactly N bytes,
 * then a CRLF of framing, then OK. At most `maxBodyKb` plus slack is ever read,
 * so a server cannot make this client hold a script of its choosing.
 */
async function readScript(conn: SieveConnection, name: string, maxBodyKb: number): Promise<SieveScript> {
  conn.write(`GETSCRIPT "${escapeQuoted(name)}"\r\n`)

  const line = await conn.readLine()
  if (isFailure(line)) {
    throw new ToolError('not_found', 'no sieve script by that name, list_sieve_scripts shows the ones there are')
  }

  const declared = literalLength(line)
  if (declared === null) throw conn.unparseable()

  const limit = readLimitBytes(maxBodyKb)
  const bytes = await conn.readBytes(Math.min(declared, limit))
  if (declared <= limit) {
    await conn.expectOk()
  } else {
    // dropped rather than closed politely: a half-close leaves a server that
    // ignores it streaming the remainder at whatever rate it likes
    conn.destroy()
  }

  return {
    content: makeUntrusted(new TextDecoder('utf-8', { fatal: false }).decode(bytes)),
    cutShort: declared > limit,
  }
}

// --- protocol grammar --------------------------------------------------------

function isOk(line: string): boolean {
  return /^OK(\s|$)/.test(line)
}

/** NO is a refusal, BYE is the server ending the session, and neither is worth waiting past */
function isFailure(line: string): boolean {
  return /^(NO|BYE)(\s|$)/.test(line)
}

/** `{79}` or `{79+}`, where `+` marks a non-synchronizing literal, all ManageSieve uses */
function literalLength(line: string): number | null {
  const match = /^\{(\d{1,9})\+?\}$/.exec(line.trim())
  return match ? Number(match[1]) : null
}

function escapeQuoted(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function parseQuoted(line: string): { value: string; rest: string } | null {
  if (!line.startsWith('"')) return null

  let value = ''
  for (let i = 1; i < line.length; i++) {
    if (line[i] === '\\') {
      i += 1
      if (i >= line.length) return null
      value += line[i]
      continue
    }
    if (line[i] === '"') return { value, rest: line.slice(i + 1) }
    value += line[i]
  }
  return null
}

// --- the connection ----------------------------------------------------------

/** the protocol is strictly turn-taking, so a single wakeup slot is enough */
class SieveConnection {
  private buffer: Buffer = Buffer.alloc(0)
  private wake: (() => void) | null = null
  private failure: ToolError | null = null

  private constructor(
    private socket: Socket,
    private readonly target: Target,
  ) {
    this.attach(socket)
  }

  static open(target: Target): Promise<SieveConnection> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: target.host, port: target.port })
      socket.setTimeout(TIMEOUT_MS)

      const onError = (): void => {
        socket.destroy()
        reject(unreachable(target))
      }
      const onTimeout = (): void => {
        socket.destroy()
        reject(timedOut(target))
      }
      socket.once('error', onError)
      socket.once('timeout', onTimeout)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        socket.removeListener('timeout', onTimeout)
        resolve(new SieveConnection(socket, target))
      })
    })
  }

  write(command: string): void {
    this.socket.write(command)
  }

  async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(0x0a)
      if (end !== -1) {
        const raw = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end + 1)
        const line = raw.toString('utf8')
        return line.endsWith('\r') ? line.slice(0, -1) : line
      }
      if (this.buffer.length > MAX_LINE_BYTES) throw this.unparseable()
      await this.fill()
    }
  }

  async readBytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) await this.fill()

    const bytes = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return bytes
  }

  /** The CRLF that frames a literal arrives as an empty line before the OK. */
  async expectOk(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const line = await this.readLine()
      if (line === '') continue
      if (isOk(line)) return
      throw this.unparseable()
    }
    throw this.unparseable()
  }

  /** Capability lines are `"NAME"` optionally followed by a value, terminated by OK. */
  async readCapabilities(): Promise<Set<string>> {
    const capabilities = new Set<string>()

    for (let i = 0; i < MAX_CAPABILITY_LINES; i++) {
      const line = await this.readLine()
      if (isOk(line)) return capabilities
      if (isFailure(line)) {
        throw new ToolError(
          'connect',
          `the sieve server at ${this.target.host}:${this.target.port} refused the connection`,
        )
      }

      const quoted = parseQuoted(line)
      if (quoted) capabilities.add(quoted.value.toUpperCase())
    }
    throw this.unparseable()
  }

  async authenticate(user: string, password: string): Promise<void> {
    const credential = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')
    this.write(`AUTHENTICATE "PLAIN" "${credential}"\r\n`)

    // the server's own refusal text is read and dropped: a failed-login response
    // is the last place a leaked credential would be noticed
    if (!isOk(await this.readLine())) {
      throw new ToolError(
        'auth',
        `the sieve server rejected the credentials. Check EMAIL_USER and the password; ${APP_PASSWORD_ADVICE}`,
      )
    }
  }

  /**
   * The reader is detached first so the handshake bytes are not eaten as
   * protocol data, and anything already buffered means the server sent content
   * it had no business sending before TLS, treated as a downgrade attempt
   * rather than parsed.
   */
  async upgrade(cfg: Config): Promise<void> {
    if (this.buffer.length > 0) {
      throw new ToolError(
        'connect',
        `the sieve server at ${this.target.host}:${this.target.port} sent data before TLS started. Refusing to continue`,
      )
    }

    const plain = this.socket
    this.detach(plain)

    const secure = tlsConnect({ socket: plain, ...secureOptions(this.target.host, cfg.tlsCaFile) })

    // Armed BEFORE the handshake. The plaintext socket's timeout handler was just
    // detached, so between here and secureConnect a server that answers OK to
    // STARTTLS and then goes silent would be watched by nothing.
    secure.setTimeout(TIMEOUT_MS)

    await new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        secure.destroy()
        reject(
          new ToolError(
            'connect',
            `TLS could not be established with the sieve server at ${this.target.host}:${this.target.port}. ` +
              `If this is a private server with its own CA, ${TLS_CA_ADVICE}`,
          ),
        )
      }
      const onTimeout = (): void => {
        secure.destroy()
        reject(timedOut(this.target))
      }
      secure.once('error', onError)
      secure.once('timeout', onTimeout)
      secure.once('secureConnect', () => {
        // both come off here, or they would co-fire with the handlers attach()
        // installs for the rest of the session
        secure.removeListener('error', onError)
        secure.removeListener('timeout', onTimeout)
        resolve()
      })
    })

    this.socket = secure
    this.attach(secure)
  }

  /**
   * Ends the session without awaiting the reply, or a server that closes first
   * turns a completed read into a failure. The reader comes off before that, or
   * a server still pushing content would go on filling the buffer while the
   * inactivity timeout never fires. Only the data handler, never the error
   * handler: end() on a socket the peer has reset emits an error, and one with
   * no listener takes the process down.
   */
  close(): void {
    this.socket.off('data', this.onData)
    if (!this.socket.destroyed) this.socket.end('LOGOUT\r\n')
  }

  destroy(): void {
    this.socket.destroy()
  }

  unparseable(): ToolError {
    return new ToolError(
      'server',
      `the sieve server at ${this.target.host}:${this.target.port} sent a reply this client could not parse`,
    )
  }

  // held by reference so the TLS upgrade can remove exactly the listeners this
  // class added, leaving the socket implementation's own in place
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.resume()
  }
  private readonly onError = (): void => this.stop(connectionFailed(this.target))
  private readonly onTimeout = (): void => {
    this.socket.destroy()
    this.stop(timedOut(this.target))
  }
  private readonly onClose = (): void => this.stop(closedEarly(this.target))

  private attach(socket: Socket): void {
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('timeout', this.onTimeout)
    socket.on('close', this.onClose)
  }

  private detach(socket: Socket): void {
    socket.off('data', this.onData)
    socket.off('error', this.onError)
    socket.off('timeout', this.onTimeout)
    socket.off('close', this.onClose)
  }

  private stop(error: ToolError): void {
    this.failure ??= error
    this.resume()
  }

  private resume(): void {
    const waiter = this.wake
    this.wake = null
    waiter?.()
  }

  private async fill(): Promise<void> {
    if (this.failure) throw this.failure
    await new Promise<void>((resolve) => {
      this.wake = resolve
    })
    if (this.failure) throw this.failure
  }
}

/** only for a connection that never came up, where the "check SIEVE_HOST" advice is true */
function unreachable(target: Target): ToolError {
  return new ToolError(
    'connect',
    `could not establish a sieve connection to ${target.host}:${target.port}. Check SIEVE_HOST and SIEVE_PORT`,
  )
}

function connectionFailed(target: Target): ToolError {
  return new ToolError('connect', `the connection to the sieve server at ${target.host}:${target.port} failed`)
}

function timedOut(target: Target): ToolError {
  return new ToolError(
    'connect',
    `timed out talking to the sieve server at ${target.host}:${target.port}. Check the network and any firewall`,
  )
}

function closedEarly(target: Target): ToolError {
  return new ToolError(
    'connect',
    `the sieve server at ${target.host}:${target.port} closed the connection before the reply was complete`,
  )
}
