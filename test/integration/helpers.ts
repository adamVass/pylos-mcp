import { readFileSync } from 'node:fs'
import { rootCertificates } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { it } from 'vitest'
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { loadConfig, type Config } from '../../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))

// reading UntrustedText via readUntrusted is fine in tests, since the
// architecture test only binds src/

/** self-signed certificate of the local Dovecot test container (docker/gen-certs.sh) */
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

/** seeds over its own connection, so a defect in the code under test cannot corrupt the fixture */
export function seedClient(cfg: Config = testConfig()): ImapFlow {
  return new ImapFlow({
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
}

/** MailComposer predates promises and still takes a Node-style callback */
export function build(options: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(options).compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err)
      else resolve(message)
    })
  })
}
