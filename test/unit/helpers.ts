import type { ImapSession } from '../../src/core/client.js'

export function fakeSession(client: unknown): ImapSession {
  return {
    withMailbox: <T>(_path: string, fn: (c: never) => Promise<T>): Promise<T> => fn(client as never),
  } as unknown as ImapSession
}

/** lets exact assertions rebuild the fence markers */
export function nonceOf(text: string): string {
  const match = /<<<UNTRUSTED EMAIL CONTENT ([0-9a-f]{16}) /.exec(text)
  if (!match) throw new Error('no fence in output')
  return match[1]
}
