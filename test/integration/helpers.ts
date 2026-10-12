import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { rootCertificates } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { it } from 'vitest'
import { ImapFlow } from 'imapflow'
import { getEmail } from '../../src/core/message.js'
import type { ImapSession } from '../../src/core/client.js'
import { readUntrusted } from '../../src/safety/untrusted.js'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { loadConfig, type Config } from '../../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))

export const testCaFile = join(here, 'docker', 'certs', 'cert.pem')

/** points at the loopback Dovecot container started by run.sh, never a real server */
export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    EMAIL_USER: 'tester',
    EMAIL_PASSWORD: 'testpass',
    IMAP_HOST: 'localhost',
    IMAP_PORT: process.env.PYLOS_IMAP_PORT ?? '10993',
    TLS_CA_FILE: testCaFile,
    SIEVE_HOST: 'localhost',
    SIEVE_PORT: process.env.PYLOS_SIEVE_PORT ?? '14190',
    ...overrides,
  })
}

/** used instead of bare `it`, so a plain `npm test` skips these rather than reaching for Docker */
export const itIntegration = process.env.RUN_INTEGRATION ? it : it.skip

export const SENDER = 'Sender Name <sender@x.example>'

/**
 * cycles all 256 byte values so a round-trip that mangles high bytes or translates CRLF changes the
 * content, not just the length
 */
export const KNOWN_PDF_BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))

// big enough that base64 expansion cannot bring the declared size back under a 1 MB cap
export const BIG_BYTES = Buffer.alloc(1_200_000, 0x42)

/**
 * seeds over its own connection so a defect under test cannot corrupt the fixture. Fixtures never
 * go in INBOX or Drafts, the search suite asserts absolute counts there
 */
export async function seedClient(cfg: Config = testConfig()): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: true,
    servername: cfg.imap.host,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    emitLogs: false,
    tls: {
      rejectUnauthorized: true,
      servername: cfg.imap.host,
      ca: [...rootCertificates, readFileSync(testCaFile, 'utf8')],
    },
  })
  client.on('error', () => {})
  await client.connect()
  return client
}

/**
 * The NOOP is load-bearing. A message another connection changed is invisible
 * to an already-selected session until the server announces it with an untagged
 * response, and Dovecot only does that during a command that permits one.
 * Without it SEARCH returns nothing and UID FETCH answers `false` for a message
 * that demonstrably exists.
 */
export async function inMailbox<T>(client: ImapFlow, path: string, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path)
  try {
    await client.noop()
    return await fn()
  } finally {
    lock.release()
  }
}

export function uidsIn(client: ImapFlow, folder: string): Promise<number[]> {
  return inMailbox(client, folder, async () => (await client.search({ all: true }, { uid: true })) || [])
}

export function flagsOf(client: ImapFlow, folder: string, uid: number): Promise<Set<string>> {
  return inMailbox(client, folder, async () => {
    const message = await client.fetchOne(String(uid), { flags: true }, { uid: true })
    if (!message) throw new Error(`no message with uid ${uid} in ${folder}`)
    return message.flags ?? new Set<string>()
  })
}

export function sourceOf(client: ImapFlow, folder: string, uid: number): Promise<Buffer> {
  return inMailbox(client, folder, async () => {
    const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
    if (!message || !message.source) throw new Error(`no message with uid ${uid} in ${folder}`)
    return message.source
  })
}

/**
 * cleanup is a set difference against a baseline, so a message appended by a call that then failed
 * (or saved without a reported UID) is not left behind
 */
export async function removeStrays(client: ImapFlow, folder: string, baseline: Set<number>): Promise<void> {
  await inMailbox(client, folder, async () => {
    const uids = (await client.search({ all: true }, { uid: true })) || []
    const strays = uids.filter((uid) => !baseline.has(uid))
    if (strays.length > 0) await client.messageDelete(strays, { uid: true })
  })
}

export async function partIdFor(session: ImapSession, folder: string, uid: number, filename: string): Promise<string> {
  const email = await getEmail(session, folder, uid, 64)
  const match = email.attachments.find((a) => readUntrusted(a.filename) === filename)
  if (!match) throw new Error(`no attachment named ${filename} on uid ${uid}`)
  return match.partId
}

export function ensureCerts(): void {
  if (existsSync(testCaFile)) return
  execFileSync('bash', [join(here, 'docker', 'gen-certs.sh')], { stdio: 'inherit' })
}

/** header order is fixed so message bytes stay comparable across suites */
export function rawMessage(options: {
  subject: string
  body?: string
  date?: Date
  from?: string
  headers?: string[]
}): Buffer {
  const { subject, body = 'body', date, from = SENDER, headers = [] } = options
  return Buffer.from(
    [
      `From: ${from}`,
      'To: tester@x.example',
      `Subject: ${subject}`,
      ...(date ? [`Date: ${date.toUTCString().replace('GMT', '+0000')}`] : []),
      ...headers,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\r\n'),
  )
}

export function build(options: Record<string, unknown>): Promise<Buffer> {
  return new MailComposer(options).compile().build()
}
