import type { ImapSession } from '../../src/core/client.js'

export function fakeSession(client: unknown): ImapSession {
  return {
    withMailbox: <T>(_path: string, fn: (c: never) => Promise<T>): Promise<T> => fn(client as never),
  } as unknown as ImapSession
}
