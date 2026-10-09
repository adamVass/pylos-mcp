import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { ImapFlow } from 'imapflow'
import { ImapSession } from '../../src/core/client.js'
import { searchEmails } from '../../src/core/search.js'
import { readUntrusted } from '../../src/safety/untrusted.js'
import type { RenderableSummary } from '../../src/safety/render.js'
import { itIntegration, seedClient, testConfig } from './helpers.js'

const SENDER = 'Sender Name <sender@x.example>'
const RECIPIENT = 'tester@x.example'
const SUBJECTS = Array.from({ length: 12 }, (_, i) => `msg-${String(i + 1).padStart(2, '0')}`)
const NEEDLE_SUBJECTS = new Set(['msg-03', 'msg-07', 'msg-11'])

/**
 * Date: headers run BACKWARDS, msg-01 claiming the newest date and msg-12 the
 * oldest. "Newest first" means arrival order (UID), and the Date: header is
 * attacker-supplied text that must not decide it, so an implementation that
 * sorted on the header would fail every ordering assertion below.
 */
function headerDate(index: number): Date {
  return new Date(Date.UTC(2026, 6, 12 - index))
}

function rfc822(subject: string, date: Date, body: string): Buffer {
  return Buffer.from(
    [
      `From: ${SENDER}`,
      `To: ${RECIPIENT}`,
      `Subject: ${subject}`,
      `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\r\n'),
  )
}

function subjectsOf(items: RenderableSummary[]): string[] {
  return items.map((item) => readUntrusted(item.subject))
}

describe('searchEmails against a local Dovecot container', () => {
  let session: ImapSession
  let seeder: ImapFlow | undefined

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    seeder = seedClient()
    seeder.on('error', () => {})
    await seeder.connect()

    // the counts asserted below are absolute, so fail loudly rather than as a
    // count mismatch if something else has already put mail in either folder
    for (const path of ['INBOX', 'Drafts']) {
      const { messages } = await seeder.status(path, { messages: true })
      if (messages !== 0) {
        throw new Error(`${path} must be empty before seeding, found ${messages} message(s)`)
      }
    }

    for (const [index, subject] of SUBJECTS.entries()) {
      const body = NEEDLE_SUBJECTS.has(subject) ? 'this body contains a needle' : 'nothing to see here'
      await seeder.append('INBOX', rfc822(subject, headerDate(index), body), [])
    }
    await seeder.append('Drafts', rfc822('draft-01', headerDate(0), 'a draft'), ['\\Seen', '\\Flagged'])

    session = new ImapSession(testConfig())
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await seeder?.logout().catch(() => undefined)
  })

  itIntegration('C-1 regression: returns the NEWEST messages first, then paginates', async () => {
    const { total, items } = await searchEmails(session, { limit: 5, offset: 0 })
    expect(total).toBe(12)
    expect(subjectsOf(items)).toEqual(['msg-12', 'msg-11', 'msg-10', 'msg-09', 'msg-08'])
  })

  itIntegration('offset continues the newest-first ordering without gaps or repeats', async () => {
    const page1 = await searchEmails(session, { limit: 5, offset: 0 })
    const page2 = await searchEmails(session, { limit: 5, offset: 5 })
    const page3 = await searchEmails(session, { limit: 5, offset: 10 })

    expect(subjectsOf(page2.items)).toEqual(['msg-07', 'msg-06', 'msg-05', 'msg-04', 'msg-03'])
    expect(subjectsOf(page3.items)).toEqual(['msg-02', 'msg-01'])
    expect(subjectsOf([...page1.items, ...page2.items, ...page3.items])).toEqual([...SUBJECTS].reverse())
  })

  itIntegration('an offset past the end reports the total with no items', async () => {
    const { total, items } = await searchEmails(session, { limit: 5, offset: 50 })
    expect(total).toBe(12)
    expect(items).toEqual([])
  })

  itIntegration('full-text query filters server-side', async () => {
    const { total, items } = await searchEmails(session, { query: 'needle', limit: 50, offset: 0 })
    expect(total).toBe(3)
    expect(subjectsOf(items)).toEqual(['msg-11', 'msg-07', 'msg-03'])
  })

  itIntegration('from, to and subject filters apply', async () => {
    expect((await searchEmails(session, { from: 'sender@x.example', limit: 50, offset: 0 })).total).toBe(12)
    expect((await searchEmails(session, { from: 'nobody@x.example', limit: 50, offset: 0 })).total).toBe(0)
    expect((await searchEmails(session, { to: RECIPIENT, limit: 50, offset: 0 })).total).toBe(12)
    expect((await searchEmails(session, { subject: 'msg-07', limit: 50, offset: 0 })).total).toBe(1)
  })

  itIntegration('unreadOnly and date filters apply', async () => {
    // Nothing in this suite fetches a body, so no INBOX message is seen. The
    // seeded Drafts message has \Seen and is the one that proves unreadOnly
    // excludes rather than being a no-op.
    expect((await searchEmails(session, { unreadOnly: true, limit: 50, offset: 0 })).total).toBe(12)
    expect((await searchEmails(session, { folder: 'Drafts', unreadOnly: true, limit: 50, offset: 0 })).total).toBe(0)

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    expect((await searchEmails(session, { since: yesterday, limit: 50, offset: 0 })).total).toBe(12)
    // A future `since` is compiled by imapflow into the WITHIN form YOUNGER 0,
    // which Dovecot rejects, and imapflow reports a rejected search as no
    // matches, which is also what the filter means.
    expect((await searchEmails(session, { since: new Date('2030-01-01'), limit: 50, offset: 0 })).total).toBe(0)
    expect((await searchEmails(session, { before: new Date('2020-01-01'), limit: 50, offset: 0 })).total).toBe(0)
  })

  itIntegration('an unfiltered search does not accidentally filter', async () => {
    // A search object built with `undefined` values instead of absent keys
    // compiles to UNSEEN (for `seen`) or to a criteria-less UID SEARCH the server
    // rejects, both of which silently return the wrong set. Drafts holds the one
    // \Seen message, so it is where a stray UNSEEN shows up.
    expect((await searchEmails(session, { limit: 50, offset: 0 })).total).toBe(12)
    expect((await searchEmails(session, { unreadOnly: false, limit: 50, offset: 0 })).total).toBe(12)
    expect((await searchEmails(session, { folder: 'Drafts', limit: 50, offset: 0 })).total).toBe(1)
    expect((await searchEmails(session, { folder: 'Drafts', unreadOnly: false, limit: 50, offset: 0 })).total).toBe(1)
  })

  itIntegration('maps envelope, size and flags into the summary', async () => {
    const { items } = await searchEmails(session, { limit: 1, offset: 0 })
    const newest = items[0]

    expect(readUntrusted(newest.subject)).toBe('msg-12')
    expect(readUntrusted(newest.from)).toBe(SENDER)
    expect(newest.folder).toBe('INBOX')
    expect(newest.uid).toBeGreaterThan(0)
    expect(newest.sizeBytes).toBeGreaterThan(0)
    expect(newest.date).toEqual(headerDate(11))
    expect(newest.seen).toBe(false)
    expect(newest.flagged).toBe(false)
  })

  itIntegration('searches the folder it is given and reads seen and flagged from the flags', async () => {
    const { total, items } = await searchEmails(session, { folder: 'Drafts', limit: 50, offset: 0 })
    expect(total).toBe(1)
    expect(items[0].folder).toBe('Drafts')
    expect(readUntrusted(items[0].subject)).toBe('draft-01')
    expect(items[0].seen).toBe(true)
    expect(items[0].flagged).toBe(true)
  })
})
