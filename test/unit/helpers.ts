import type { Server } from 'node:net'
import { Readable } from 'node:stream'
import { vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import type { ImapSession } from '../../src/core/client.js'
import type { RenderableEmail } from '../../src/safety/render.js'
import { makeUntrusted } from '../../src/safety/untrusted.js'

export function fakeSession(client: unknown, extra: Partial<ImapSession> = {}): ImapSession {
  return {
    withMailbox: <T>(_path: string, fn: (c: never) => Promise<T>): Promise<T> => fn(client as never),
    ...extra,
  } as unknown as ImapSession
}

export function fakeClient(opts: {
  message: Record<string, unknown>
  body?: Iterable<Buffer>
  meta?: Record<string, unknown>
  events?: string[]
}) {
  return {
    fetchOne: async () => {
      opts.events?.push('fetch')
      return opts.message
    },
    download: vi.fn(async () => {
      opts.events?.push('download')
      return { content: Readable.from(opts.body ?? []), meta: opts.meta ?? {} }
    }),
  }
}

// nothing listens on port 1, so a send that gets past the dialog fails at connect
export function confirmSendConfig(over: Record<string, string> = {}) {
  return loadConfig({
    EMAIL_USER: 'a@x.example',
    EMAIL_PASSWORD: 'pw',
    IMAP_HOST: 'localhost',
    CAPABILITIES: 'send',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SEND_ALLOWLIST: '*@x.example',
    SEND_CONFIRM: 'true',
    ...over,
  })
}

/** lets exact assertions rebuild the fence markers */
export function nonceOf(text: string): string {
  const match = /<<<UNTRUSTED EMAIL CONTENT ([0-9a-f]{16}) /.exec(text)
  if (!match) throw new Error('no fence in output')
  return match[1]
}

export async function listenOnAnyPort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

export function renderableEmail(over: Partial<RenderableEmail> = {}): RenderableEmail {
  return {
    folder: 'INBOX',
    uid: 7,
    sent: new Date('2026-08-05T10:00:00Z'),
    received: new Date('2026-08-05T10:00:05Z'),
    sizeBytes: 4200,
    from: makeUntrusted('Alice <alice@x.example>'),
    fromName: makeUntrusted('Alice'),
    fromAddress: makeUntrusted('alice@x.example'),
    replyTo: [],
    replyToAddresses: [],
    to: makeUntrusted('adam@x.example'),
    cc: makeUntrusted(''),
    subject: makeUntrusted('Hi'),
    body: makeUntrusted('Plain body'),
    bodyCutShort: false,
    bodyIsHtml: false,
    attachments: [],
    ...over,
  }
}
