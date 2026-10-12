import type { Server } from 'node:net'
import type { ImapSession } from '../../src/core/client.js'
import type { RenderableEmail } from '../../src/safety/render.js'
import { makeUntrusted } from '../../src/safety/untrusted.js'

export function fakeSession(client: unknown, extra: Partial<ImapSession> = {}): ImapSession {
  return {
    withMailbox: <T>(_path: string, fn: (c: never) => Promise<T>): Promise<T> => fn(client as never),
    ...extra,
  } as unknown as ImapSession
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
