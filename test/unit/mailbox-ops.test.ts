// Stub-based rather than run against the Dovecot container: Dovecot 2.4.4
// advertises MOVE, so there is no way to make it answer as a server that lacks
// the extension. What is pinned is pure decision logic, "refuse before mutating"
// and "name the flag that failed", not IMAP wire behavior.

import { describe, expect, it, vi } from 'vitest'
import type { ImapFlow } from 'imapflow'
import { moveEmail, setFlags } from '../../src/core/mailbox-ops.js'
import { fakeSession } from './helpers.js'

function baseClient(overrides: Partial<ImapFlow> = {}): Partial<ImapFlow> {
  return {
    capabilities: new Map([['UIDPLUS', true]]),
    enabled: new Set(),
    fetchOne: vi.fn().mockResolvedValue({ uid: 7 }),
    ...overrides,
  }
}

describe('moveEmail refuses to emulate MOVE on a server that lacks it', () => {
  it('throws before requireMessage or messageMove/messageCopy run', async () => {
    const messageMove = vi.fn()
    const messageCopy = vi.fn()
    const fetchOne = vi.fn().mockResolvedValue({ uid: 7 })
    const client = baseClient({ messageMove, messageCopy, fetchOne })

    await expect(moveEmail(fakeSession(client), 'INBOX', 7, 'Archive')).rejects.toMatchObject({ code: 'server' })

    expect(fetchOne).not.toHaveBeenCalled()
    expect(messageMove).not.toHaveBeenCalled()
    expect(messageCopy).not.toHaveBeenCalled()
  })

  it('the refusal message explains why, without the word "permanent"', async () => {
    const client = baseClient({ messageMove: vi.fn() })
    const error = await moveEmail(fakeSession(client), 'INBOX', 7, 'Archive').catch((e: Error) => e)

    expect((error as Error).message).toMatch(/MOVE capability/i)
    expect((error as Error).message.toLowerCase()).not.toContain('permanent')
  })

  it('proceeds when the server advertises MOVE directly', async () => {
    const messageMove = vi.fn().mockResolvedValue({ path: 'INBOX', destination: 'Archive', uidMap: new Map([[7, 7]]) })
    const client = baseClient({
      capabilities: new Map([['MOVE', true]]),
      messageMove,
    })

    await expect(moveEmail(fakeSession(client), 'INBOX', 7, 'Archive')).resolves.toBeUndefined()
    expect(messageMove).toHaveBeenCalledOnce()
  })

  it('proceeds when IMAP4rev2 folds MOVE in without a separate capability token', async () => {
    const messageMove = vi.fn().mockResolvedValue({ path: 'INBOX', destination: 'Archive', uidMap: new Map([[7, 7]]) })
    const client = baseClient({
      capabilities: new Map([['IMAP4rev2', true]]),
      messageMove,
    })

    await expect(moveEmail(fakeSession(client), 'INBOX', 7, 'Archive')).resolves.toBeUndefined()
    expect(messageMove).toHaveBeenCalledOnce()
  })

  it('proceeds when IMAP4REV2 was explicitly ENABLEd rather than being the only base protocol', async () => {
    const messageMove = vi.fn().mockResolvedValue({ path: 'INBOX', destination: 'Archive', uidMap: new Map([[7, 7]]) })
    const client = baseClient({
      capabilities: new Map([
        ['IMAP4rev1', true],
        ['IMAP4rev2', true],
      ]),
      enabled: new Set(['IMAP4REV2']),
      messageMove,
    })

    await expect(moveEmail(fakeSession(client), 'INBOX', 7, 'Archive')).resolves.toBeUndefined()
    expect(messageMove).toHaveBeenCalledOnce()
  })
})

describe('setFlags names the flag that failed', () => {
  it('reports which flag failed after the other one already reached the server', async () => {
    const calls: string[] = []
    const messageFlagsAdd = vi.fn(async (_range: string, flags: string[]) => {
      calls.push(flags[0])
      return flags[0] === '\\Seen' // \Seen succeeds, \Flagged fails
    })
    const client = baseClient({ messageFlagsAdd: messageFlagsAdd as unknown as ImapFlow['messageFlagsAdd'] })

    const error = await setFlags(fakeSession(client), 'INBOX', 7, { seen: true, flagged: true }).catch((e: Error) => e)

    expect((error as { code?: string }).code).toBe('server')
    expect((error as Error).message).toContain('\\Flagged')
    expect((error as Error).message).not.toContain('\\Seen')
    // \Seen's change already reached the server before the throw, which is the
    // partial mutation the error message exists to make legible
    expect(calls).toEqual(['\\Seen', '\\Flagged'])
  })

  it('names the flag on a clear (remove) failure too, distinctly from a set failure', async () => {
    const messageFlagsRemove = vi.fn().mockResolvedValue(false)
    const client = baseClient({ messageFlagsRemove: messageFlagsRemove as unknown as ImapFlow['messageFlagsRemove'] })

    const error = await setFlags(fakeSession(client), 'INBOX', 7, { seen: false }).catch((e: Error) => e)

    expect((error as Error).message).toContain('clearing \\Seen')
  })
})
