import { afterAll, afterEach, beforeAll, describe, expect, vi } from 'vitest'
import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import { ImapSession } from '../../src/core/client.js'
import { createDraft } from '../../src/core/draft.js'
import { getEmail } from '../../src/core/message.js'
import { readUntrusted } from '../../src/safety/untrusted.js'
import { build, itIntegration, seedClient, testConfig } from './helpers.js'

// the search suite asserts absolute counts on INBOX and Drafts, so fixtures must
// not go there
const FOLDER = 'T7Fixtures'

const DRAFTS = 'Drafts'

const SENDER = 'Sender Name <sender@x.example>'

/**
 * Cycles all 256 byte values rather than repeating one: a round-trip that
 * mangles high bytes or translates CRLF yields a buffer of the right length but
 * different content, which a uniform filler would hide.
 */
const KNOWN_PDF_BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))

// Big enough that base64 expansion cannot bring the DECLARED size back under
// the 1 MB cap the cap test sets, and far from the boundary either way.
const BIG_BYTES = Buffer.alloc(1_200_000, 0x42)

/** mailparser hands back one AddressObject per header occurrence, or just one */
function addressText(field: AddressObject | AddressObject[] | undefined): string {
  if (!field) return ''
  return (Array.isArray(field) ? field : [field]).map((a) => a.text).join(', ')
}

describe('createDraft against a local Dovecot container', () => {
  let session: ImapSession
  let seeder: ImapFlow | undefined

  let uidMultipart = 0
  let uidBig = 0

  /**
   * Cleanup is a set difference against this rather than a list of the UIDs
   * createDraft returned: a draft appended by a call that then failed, or one the
   * server saved without reporting a UID, would otherwise be left behind.
   */
  let preexistingDraftUids = new Set<number>()

  /**
   * The NOOP is load-bearing. A message another connection APPENDed is invisible
   * to an already-selected session until the server announces it with an untagged
   * EXISTS, and Dovecot only does that during a command that permits untagged
   * responses. Without it, SEARCH returns nothing and UID FETCH answers `false`
   * for a draft that demonstrably exists.
   */
  async function withDrafts<T>(fn: () => Promise<T>): Promise<T> {
    const lock = await seeder!.getMailboxLock(DRAFTS)
    try {
      await seeder!.noop()
      return await fn()
    } finally {
      lock.release()
    }
  }

  async function draftUids(): Promise<number[]> {
    return withDrafts(async () => (await seeder!.search({ all: true }, { uid: true })) || [])
  }

  async function removeNewDrafts(): Promise<void> {
    if (!seeder) return
    await withDrafts(async () => {
      const uids = (await seeder!.search({ all: true }, { uid: true })) || []
      const strays = uids.filter((uid) => !preexistingDraftUids.has(uid))
      if (strays.length > 0) await seeder!.messageDelete(strays, { uid: true })
    })
  }

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    seeder = seedClient()
    seeder.on('error', () => {})
    await seeder.connect()

    await seeder.mailboxCreate(FOLDER).catch(() => undefined)

    // Taken BEFORE the emptiness check below, because afterAll runs even when
    // beforeAll throws: an empty baseline at that point makes removeNewDrafts
    // treat every pre-existing draft as a stray and delete the lot.
    preexistingDraftUids = new Set(await draftUids())

    const { messages } = await seeder.status(FOLDER, { messages: true })
    if (messages !== 0) {
      throw new Error(`${FOLDER} must be empty before seeding, found ${messages} message(s)`)
    }

    const common = { from: SENDER, to: 'tester@x.example' }

    const multipart = await build({
      ...common,
      subject: 'source with a pdf',
      text: 'the plain part',
      attachments: [{ filename: 'report.pdf', content: KNOWN_PDF_BYTES, contentType: 'application/pdf' }],
    })
    const big = await build({
      ...common,
      subject: 'source with a big attachment',
      text: 'has a big attachment',
      attachments: [{ filename: 'huge.bin', content: BIG_BYTES, contentType: 'application/octet-stream' }],
    })

    for (const [message, assign] of [
      [multipart, (uid: number) => (uidMultipart = uid)],
      [big, (uid: number) => (uidBig = uid)],
    ] as const) {
      const result = await seeder.append(FOLDER, message, [])
      if (!result || result.uid === undefined) throw new Error(`APPEND to ${FOLDER} returned no UID`)
      assign(result.uid)
    }

    session = new ImapSession(testConfig())
  }, 120_000)

  afterEach(async () => {
    // per test, not per file: several tests assert an absolute Drafts count
    await removeNewDrafts()
  })

  afterAll(async () => {
    await session?.close()
    await removeNewDrafts().catch(() => undefined)
    await seeder?.logout().catch(() => undefined)
  })

  async function partIdFor(uid: number, filename: string): Promise<string> {
    const email = await getEmail(session, FOLDER, uid, 64)
    const match = email.attachments.find((a) => readUntrusted(a.filename) === filename)
    if (!match) throw new Error(`no attachment named ${filename} on uid ${uid}`)
    return match.partId
  }

  /**
   * Counted through the resynced SEARCH rather than STATUS: a STATUS on the
   * mailbox this connection has selected is answered from its own session view,
   * so a "no draft was created" assertion built on it passes even when one was.
   */
  async function draftCount(): Promise<number> {
    return (await draftUids()).length
  }

  async function draftSource(uid: number): Promise<Buffer> {
    return withDrafts(async () => {
      const message = await seeder!.fetchOne(String(uid), { source: true }, { uid: true })
      if (!message || !message.source) throw new Error(`no draft with uid ${uid} in ${DRAFTS}`)
      return message.source
    })
  }

  async function draftFlags(uid: number): Promise<Set<string>> {
    return withDrafts(async () => {
      const message = await seeder!.fetchOne(String(uid), { flags: true }, { uid: true })
      if (!message) throw new Error(`no draft with uid ${uid} in ${DRAFTS}`)
      return message.flags ?? new Set<string>()
    })
  }

  itIntegration('appends a draft with \\Draft flag to the Drafts special-use folder', async () => {
    const result = await createDraft(session, testConfig(), {
      subject: 'Plan',
      body: 'Draft body',
      to: ['x@y.example'],
    })

    expect(result.folder).toBe(DRAFTS)
    // Dovecot advertises UIDPLUS, so the honest answer here is a real UID, and
    // the `uid: null` branch for servers that do not is unexercised
    expect(typeof result.uid).toBe('number')
    expect(result.recipients).toEqual(['x@y.example'])

    expect(await draftFlags(result.uid!)).toContain('\\Draft')

    const parsed = await simpleParser(await draftSource(result.uid!))
    expect(parsed.subject).toBe('Plan')
    expect(parsed.text).toContain('Draft body')
    expect(addressText(parsed.to)).toContain('x@y.example')
  })

  itIntegration('echoes to and cc as one recipient list, in order', async () => {
    const result = await createDraft(session, testConfig(), {
      subject: 'Plan',
      body: 'b',
      to: ['a@y.example', 'b@y.example'],
      cc: ['c@y.example'],
    })

    expect(result.recipients).toEqual(['a@y.example', 'b@y.example', 'c@y.example'])

    const parsed = await simpleParser(await draftSource(result.uid!))
    expect(addressText(parsed.to)).toContain('b@y.example')
    expect(addressText(parsed.cc)).toContain('c@y.example')
  })

  itIntegration('attachment-by-reference round-trips byte-identical', async () => {
    const pdfPartId = await partIdFor(uidMultipart, 'report.pdf')

    const result = await createDraft(session, testConfig(), {
      subject: 'Fwd',
      body: 'see attached',
      attachments: [{ folder: FOLDER, uid: uidMultipart, partId: pdfPartId }],
    })

    // Asserted again here, not only in the no-attachment test: fetching a part
    // leaves its source folder selected, and imapflow validates APPEND flags
    // against the SELECTED mailbox, so this is where \Draft can be lost.
    expect(await draftFlags(result.uid!)).toContain('\\Draft')

    const parsed = await simpleParser(await draftSource(result.uid!))
    expect(parsed.attachments).toHaveLength(1)

    const attachment = parsed.attachments[0]
    expect(attachment.filename).toBe('report.pdf')
    expect(attachment.contentType).toBe('application/pdf')
    expect(attachment.content).toEqual(KNOWN_PDF_BYTES)
    expect(parsed.text).toContain('see attached')
  })

  itIntegration('by-reference attachment over the cap → cap_exceeded, no draft created', async () => {
    const cfg = testConfig({ MAX_ATTACHMENT_MB: '1' })
    const bigPartId = await partIdFor(uidBig, 'huge.bin')
    const before = await draftCount()

    // the ordering IS the requirement: the cap is decided from the declared
    // bodystructure size, so no byte of the part may ever be requested
    const spy = vi.spyOn(ImapFlow.prototype, 'download')
    try {
      await expect(
        createDraft(session, cfg, {
          subject: 'big',
          body: 'x',
          attachments: [{ folder: FOLDER, uid: uidBig, partId: bigPartId }],
        }),
      ).rejects.toMatchObject({ code: 'cap_exceeded' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }

    expect(await draftCount()).toBe(before)
  })

  itIntegration('a failing attachment leaves no draft behind, even after a good one', async () => {
    const cfg = testConfig({ MAX_ATTACHMENT_MB: '1' })
    const pdfPartId = await partIdFor(uidMultipart, 'report.pdf')
    const bigPartId = await partIdFor(uidBig, 'huge.bin')
    const before = await draftCount()

    // the good attachment is fetched first and the bad one fails afterwards, so
    // this pins that failure is decided before the APPEND rather than after
    await expect(
      createDraft(session, cfg, {
        subject: 'mixed',
        body: 'x',
        attachments: [
          { folder: FOLDER, uid: uidMultipart, partId: pdfPartId },
          { folder: FOLDER, uid: uidBig, partId: bigPartId },
        ],
      }),
    ).rejects.toMatchObject({ code: 'cap_exceeded' })

    expect(await draftCount()).toBe(before)
  })

  itIntegration('an unknown part id → not_found, no draft created', async () => {
    const before = await draftCount()

    await expect(
      createDraft(session, testConfig(), {
        subject: 'nope',
        body: 'x',
        attachments: [{ folder: FOLDER, uid: uidMultipart, partId: '9.9' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(await draftCount()).toBe(before)
  })

  itIntegration('DRAFTS_NO_RECIPIENTS=true rejects to/cc with ToolError policy', async () => {
    const cfg = testConfig({ DRAFTS_NO_RECIPIENTS: 'true' })
    const before = await draftCount()

    await expect(createDraft(session, cfg, { subject: 's', body: 'b', to: ['a@b.example'] })).rejects.toMatchObject({
      code: 'policy',
      message: expect.stringContaining('DRAFTS_NO_RECIPIENTS'),
    })
    await expect(createDraft(session, cfg, { subject: 's', body: 'b', cc: ['a@b.example'] })).rejects.toMatchObject({
      code: 'policy',
    })
    expect(await draftCount()).toBe(before)

    const ok = await createDraft(session, cfg, { subject: 's', body: 'b' })
    expect(ok.recipients).toEqual([])

    const parsed = await simpleParser(await draftSource(ok.uid!))
    expect(parsed.to).toBeUndefined()
    expect(parsed.cc).toBeUndefined()
  })
})
