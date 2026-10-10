import { it, expect } from 'vitest'
import { searchEmails } from '../../src/core/search.js'
import type { ImapSession } from '../../src/core/client.js'
import { fakeSession } from './helpers.js'

/**
 * UID SEARCH answers in ASCENDING order, and so does FETCH, whatever order the
 * set was asked for. Both are reproduced here, because a stub that echoed the
 * requested order back would let a paginate-then-sort regression pass.
 */
function stubSession(uids: number[]): ImapSession {
  const client = {
    search: async () => uids,
    async *fetch(range: string) {
      const asked = range
        .split(',')
        .map(Number)
        .sort((a, b) => a - b)
      for (const uid of asked) {
        yield {
          uid,
          envelope: { date: new Date('2026-01-02T03:04:05Z'), subject: `subject ${uid}`, from: [] },
          internalDate: new Date('2026-01-02T03:04:06Z'),
          flags: new Set<string>(),
          size: 10,
        }
      }
    },
  }

  return fakeSession(client)
}

// Slicing the match set before sorting it returns the OLDEST messages under a
// "newest first" label. Asserted on the second page too, since offset is where
// sort-after-slice and sort-before-slice diverge most.
it('paginates the newest messages first, not the first page of the oldest', async () => {
  const session = stubSession([1, 2, 3, 4, 5])

  const first = await searchEmails(session, { limit: 2, offset: 0 })
  expect(first.total).toBe(5)
  expect(first.items.map((m) => m.uid)).toEqual([5, 4])

  const second = await searchEmails(session, { limit: 2, offset: 2 })
  expect(second.total).toBe(5)
  expect(second.items.map((m) => m.uid)).toEqual([3, 2])

  const past = await searchEmails(session, { limit: 2, offset: 9 })
  expect(past.items).toEqual([])
})

// imapflow compiles a present-but-undefined key into a criterion, so false must leave no key at all
it('flaggedOnly asks the server for flagged mail, and false asks for nothing extra', async () => {
  const asked: unknown[] = []
  const session = fakeSession({
    search: async (criteria: unknown) => {
      asked.push(criteria)
      return []
    },
  })
  await searchEmails(session, { flaggedOnly: true, limit: 5, offset: 0 })
  await searchEmails(session, { flaggedOnly: false, limit: 5, offset: 0 })
  expect(asked).toStrictEqual([{ flagged: true }, {}])
})
