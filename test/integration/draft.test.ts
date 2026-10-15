import { afterAll, afterEach, beforeAll, describe, expect, vi } from 'vitest'
import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import { ImapSession } from '../../src/core/client.js'
import { ComposeBudget, createDraft } from '../../src/core/draft.js'
import {
  BIG_BYTES,
  build,
  flagsOf,
  itIntegration,
  KNOWN_PDF_BYTES,
  partIdFor,
  removeStrays,
  seedClient,
  SENDER,
  sourceOf,
  testConfig,
  uidsIn,
} from './helpers.js'

const FOLDER = 'T7Fixtures'
const DRAFTS = 'Drafts'

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
  let uidOriginal = 0
  let uidLatin1 = 0

  let preexistingDraftUids = new Set<number>()

  const removeNewDrafts = async () => {
    if (seeder) await removeStrays(seeder, DRAFTS, preexistingDraftUids)
  }

  const draft = (args: Parameters<typeof createDraft>[2], cfg = testConfig()) =>
    createDraft(session, cfg, args, new ComposeBudget())

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    seeder = await seedClient()

    await seeder.mailboxCreate(FOLDER).catch(() => undefined)

    // taken before the emptiness check because afterAll runs even when beforeAll throws, and an empty baseline
    // would make removeNewDrafts delete every pre-existing draft
    preexistingDraftUids = new Set(await uidsIn(seeder, DRAFTS))

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
    const original = await build({
      ...common,
      subject: 'the original',
      text: 'please reply',
      messageId: '<original@x.example>',
      inReplyTo: '<parent@x.example>',
      references: ['<root@x.example>', '<mid@x.example>', '<parent@x.example>'],
    })

    const latin1 = Buffer.concat([
      Buffer.from(
        [
          `From: ${SENDER}`,
          'To: tester@x.example',
          'Subject: windows-1252 notes',
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="b"',
          '',
          '--b',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'see the notes',
          '--b',
          'Content-Type: text/plain; charset=windows-1252; name="notes.txt"',
          'Content-Disposition: inline; filename="notes.txt"',
          'Content-Transfer-Encoding: 8bit',
          '',
          '',
        ].join('\r\n'),
      ),
      Buffer.alloc(1000, 0xe9),
      Buffer.from('\r\n--b--\r\n'),
    ])

    for (const [message, assign] of [
      [multipart, (uid: number) => (uidMultipart = uid)],
      [big, (uid: number) => (uidBig = uid)],
      [original, (uid: number) => (uidOriginal = uid)],
      [latin1, (uid: number) => (uidLatin1 = uid)],
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

  /**
   * counted via the resynced SEARCH, since STATUS on the selected mailbox comes from the same
   * session view and passes even when a draft was created
   */
  async function draftCount(): Promise<number> {
    return (await uidsIn(seeder!, DRAFTS)).length
  }

  itIntegration(
    'appends a draft with \\Draft flag to the Drafts special-use folder, echoing to then cc in order',
    async () => {
      const result = await draft({
        subject: 'Plan',
        body: 'Draft body',
        to: ['x@y.example', 'b@y.example'],
        cc: ['c@y.example'],
      })

      expect(result.folder).toBe(DRAFTS)
      // Dovecot advertises UIDPLUS, so the honest answer here is a real UID, and
      // the `uid: null` branch for servers that do not is unexercised
      expect(typeof result.uid).toBe('number')
      expect(result.recipients).toEqual(['x@y.example', 'b@y.example', 'c@y.example'])

      expect(await flagsOf(seeder!, DRAFTS, result.uid!)).toContain('\\Draft')

      const parsed = await simpleParser(await sourceOf(seeder!, DRAFTS, result.uid!))
      expect(parsed.subject).toBe('Plan')
      expect(parsed.text).toContain('Draft body')
      expect(addressText(parsed.to)).toContain('x@y.example')
      expect(addressText(parsed.to)).toContain('b@y.example')
      expect(addressText(parsed.cc)).toContain('c@y.example')
    },
  )

  itIntegration('attachment-by-reference round-trips byte-identical', async () => {
    const pdfPartId = await partIdFor(session, FOLDER, uidMultipart, 'report.pdf')

    const result = await draft({
      subject: 'Fwd',
      body: 'see attached',
      attachments: [{ folder: FOLDER, uid: uidMultipart, partId: pdfPartId }],
    })

    // Asserted again here, not only in the no-attachment test: fetching a part
    // leaves its source folder selected, and imapflow validates APPEND flags
    // against the SELECTED mailbox, so this is where \Draft can be lost.
    expect(await flagsOf(seeder!, DRAFTS, result.uid!)).toContain('\\Draft')

    const parsed = await simpleParser(await sourceOf(seeder!, DRAFTS, result.uid!))
    expect(parsed.attachments).toHaveLength(1)

    const attachment = parsed.attachments[0]
    expect(attachment.filename).toBe('report.pdf')
    expect(attachment.contentType).toBe('application/pdf')
    expect(attachment.content).toEqual(KNOWN_PDF_BYTES)
    expect(parsed.text).toContain('see attached')
  })

  itIntegration('by-reference attachment over the cap → cap_exceeded, no draft created', async () => {
    const cfg = testConfig({ MAX_ATTACHMENT_MB: '1' })
    const bigPartId = await partIdFor(session, FOLDER, uidBig, 'huge.bin')
    const before = await draftCount()

    // the ordering IS the requirement: the cap is decided from the declared
    // bodystructure size, so no byte of the part may ever be requested
    const spy = vi.spyOn(ImapFlow.prototype, 'download')
    try {
      await expect(
        draft(
          {
            subject: 'big',
            body: 'x',
            attachments: [{ folder: FOLDER, uid: uidBig, partId: bigPartId }],
          },
          cfg,
        ),
      ).rejects.toMatchObject({ code: 'cap_exceeded' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }

    expect(await draftCount()).toBe(before)
  })

  itIntegration('a failing attachment leaves no draft behind, even after a good one', async () => {
    const cfg = testConfig({ MAX_ATTACHMENT_MB: '1' })
    const pdfPartId = await partIdFor(session, FOLDER, uidMultipart, 'report.pdf')
    const bigPartId = await partIdFor(session, FOLDER, uidBig, 'huge.bin')
    const before = await draftCount()

    // the good attachment is fetched first and the bad one fails afterwards, so
    // this pins that failure is decided before the APPEND rather than after
    await expect(
      draft(
        {
          subject: 'mixed',
          body: 'x',
          attachments: [
            { folder: FOLDER, uid: uidMultipart, partId: pdfPartId },
            { folder: FOLDER, uid: uidBig, partId: bigPartId },
          ],
        },
        cfg,
      ),
    ).rejects.toMatchObject({ code: 'cap_exceeded' })

    expect(await draftCount()).toBe(before)
  })

  itIntegration('an unknown part id → not_found, no draft created', async () => {
    const before = await draftCount()

    await expect(
      draft({
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

    await expect(draft({ subject: 's', body: 'b', to: ['a@b.example'] }, cfg)).rejects.toMatchObject({
      code: 'policy',
      message: expect.stringContaining('DRAFTS_NO_RECIPIENTS'),
    })
    await expect(draft({ subject: 's', body: 'b', cc: ['a@b.example'] }, cfg)).rejects.toMatchObject({
      code: 'policy',
    })
    expect(await draftCount()).toBe(before)

    const ok = await draft({ subject: 's', body: 'b' }, cfg)
    expect(ok.recipients).toEqual([])

    const parsed = await simpleParser(await sourceOf(seeder!, DRAFTS, ok.uid!))
    expect(parsed.to).toBeUndefined()
    expect(parsed.cc).toBeUndefined()
  })

  itIntegration('a reply draft threads under the original and leaves it unanswered and unread', async () => {
    const result = await draft({
      subject: 'Re: the original',
      body: 'my answer',
      inReplyTo: { folder: FOLDER, uid: uidOriginal },
    })

    const parsed = await simpleParser(await sourceOf(seeder!, DRAFTS, result.uid!))
    expect(parsed.inReplyTo).toBe('<original@x.example>')
    expect(parsed.references).toEqual([
      '<root@x.example>',
      '<mid@x.example>',
      '<parent@x.example>',
      '<original@x.example>',
    ])

    const flags = await flagsOf(seeder!, FOLDER, uidOriginal)
    expect(flags).not.toContain('\\Answered')
    expect(flags).not.toContain('\\Seen')
  })

  itIntegration('a quoted reply draft carries the original below the body', async () => {
    const result = await draft({
      subject: 'Re: the original',
      body: 'my answer',
      to: ['sender@x.example'],
      inReplyTo: { folder: FOLDER, uid: uidOriginal },
      quoteOriginal: true,
    })

    const parsed = await simpleParser(await sourceOf(seeder!, DRAFTS, result.uid!))
    expect(parsed.inReplyTo).toBe('<original@x.example>')
    expect(parsed.text).toMatch(/^my answer\n\nOn .+ GMT, Sender Name <sender@x\.example> wrote:\n> please reply\n?$/)
  })

  itIntegration('a reply to a message that is gone saves nothing', async () => {
    const before = await draftCount()
    await expect(
      draft({
        subject: 'Re: x',
        body: 'b',
        inReplyTo: { folder: FOLDER, uid: 999_999 },
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await draftCount()).toBe(before)
  })

  // transcoding to UTF-8 doubles every é, so the part arrives larger than the server declared
  itIntegration('a windows-1252 part that grows past its declared size is forwarded intact', async () => {
    const result = await draft(
      { subject: 'Fwd', body: 'b', attachments: [{ folder: FOLDER, uid: uidLatin1, partId: '2' }] },
      testConfig({ MAX_ATTACHMENT_MB: '1' }),
    )
    const parsed = await simpleParser(await sourceOf(seeder!, DRAFTS, result.uid!))
    const attachment = parsed.attachments[0]
    const charset = (attachment.headers.get('content-type') as { params?: { charset?: string } }).params?.charset
    expect(new TextDecoder(charset ?? 'utf-8').decode(attachment.content)).toBe('é'.repeat(1000))
  })
})
