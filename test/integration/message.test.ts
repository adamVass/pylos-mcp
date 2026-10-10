import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { ImapFlow } from 'imapflow'
import { ImapSession } from '../../src/core/client.js'
import { getAttachment, getEmail } from '../../src/core/message.js'
import { renderEmail } from '../../src/safety/render.js'
import { readUntrusted } from '../../src/safety/untrusted.js'
import { build, itIntegration, seedClient, testConfig } from './helpers.js'

// the search suite asserts absolute message counts on INBOX and Drafts, so
// putting fixtures there would break it
const FOLDER = 'T6Fixtures'

const SENDER = 'Sender Name <sender@x.example>'
const RECIPIENTS = ['tester@x.example', 'second@x.example']

/**
 * Cycles all 256 byte values rather than repeating one: a transfer that mangles
 * high bytes or translates CRLF produces a buffer of the right length but
 * different content, which a uniform filler would hide.
 */
const KNOWN_PDF_BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))

// Big enough that base64 expansion cannot bring the DECLARED size back under
// the 1 MB cap the download test sets, and far from the boundary either way.
const BIG_BYTES = Buffer.alloc(1_200_000, 0x42)

const HOSTILE_FILENAME = '../../evil.sh'

// Cyrillic is two bytes per character in UTF-8 and forces MailComposer to
// base64 the part, which is exactly the case that distinguishes a byte cap
// applied before decoding from one applied after.
const LONG_BODY = 'д'.repeat(60_000)
const LONG_BODY_BYTES = Buffer.byteLength(LONG_BODY)

const INLINE_BODY_TEXT = 'the inline body text that must not be mistaken for a file'

/** fails loudly rather than letting a refused APPEND surface as uid 0 later */
async function appendFixture(client: ImapFlow, message: Buffer): Promise<number> {
  const result = await client.append(FOLDER, message, [])
  if (!result || result.uid === undefined) throw new Error(`APPEND to ${FOLDER} returned no UID`)
  return result.uid
}

describe('getEmail/getAttachment against a local Dovecot container', () => {
  let session: ImapSession
  let seeder: ImapFlow | undefined
  let downloadDir: string

  let uidMultipart = 0
  let uidHtmlOnly = 0
  let uidBig = 0
  let uidLongBody = 0
  let uidInlineNamedBody = 0
  let uidEmptyPlain = 0
  let uidHtmlAsPlain = 0
  let uidForwarded = 0
  let uidSplit = 0

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    downloadDir = await mkdtemp(join(tmpdir(), 'pylos-t6-'))

    seeder = seedClient()
    seeder.on('error', () => {})
    await seeder.connect()

    // tolerate ALREADYEXISTS, then insist the folder is empty so the UID and
    // count assumptions below cannot silently drift
    await seeder.mailboxCreate(FOLDER).catch(() => undefined)
    const { messages } = await seeder.status(FOLDER, { messages: true })
    if (messages !== 0) {
      throw new Error(`${FOLDER} must be empty before seeding, found ${messages} message(s)`)
    }

    const common = { from: SENDER, to: RECIPIENTS.join(', ') }

    const multipart = await build({
      ...common,
      subject: 'multipart fixture',
      text: 'the plain part',
      html: '<p>the <b>html</b> alternative</p>',
      attachments: [
        { filename: 'report.pdf', content: KNOWN_PDF_BYTES, contentType: 'application/pdf' },
        {
          filename: HOSTILE_FILENAME,
          content: Buffer.from('#!/bin/sh\necho pwned\n'),
          contentType: 'application/x-sh',
        },
      ],
    })
    // MailComposer emits a bare `text/html` root for an html-only mail, a
    // SINGLEPART message whose bodystructure root carries no part id
    const htmlOnly = await build({ ...common, subject: 'html only fixture', html: '<p>only <i>html</i> here</p>' })
    const big = await build({
      ...common,
      subject: 'big attachment fixture',
      text: 'has a big attachment',
      attachments: [{ filename: 'huge.bin', content: BIG_BYTES, contentType: 'application/octet-stream' }],
    })

    const longBody = await build({ ...common, subject: 'long body fixture', text: LONG_BODY })

    // Exchange/Zimbra/ticketing shape: the real body arrives as an INLINE part
    // that happens to carry a filename. Built through `attachments` because that
    // is the only way to make MailComposer put a Content-Disposition on it.
    const inlineNamedBody = await build({
      ...common,
      subject: 'inline named body fixture',
      attachments: [
        {
          filename: 'message.txt',
          content: INLINE_BODY_TEXT,
          contentType: 'text/plain',
          contentDisposition: 'inline',
        },
        { filename: 'invoice.pdf', content: Buffer.alloc(120, 0x43), contentType: 'application/pdf' },
      ],
    })

    const emptyPlain = await build({
      ...common,
      subject: 'empty plain fixture',
      text: '  \n',
      html: '<p>the real text</p>',
    })
    const htmlAsPlain = await build({
      ...common,
      subject: 'html as plain fixture',
      text: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'html-as-plain.txt'), 'utf8'),
    })
    const forwarded = await build({
      ...common,
      subject: 'forward fixture',
      html: '<p>see the forwarded message</p>',
      attachments: [
        {
          content: Buffer.from('From: a@x.example\r\nSubject: inner\r\n\r\nthe inner text\r\n'),
          contentType: 'message/rfc822',
          contentDisposition: 'inline',
          filename: false,
        },
      ],
    })
    // Apple Mail's shape: text, an inline image, then more text. `filename: false`
    // stops nodemailer naming the text parts, which old code already listed by name
    const split = await build({
      ...common,
      subject: 'split body fixture',
      attachments: [
        { content: 'first half', contentType: 'text/plain', contentDisposition: 'inline', filename: false },
        { filename: 'x.png', content: Buffer.alloc(10, 1), contentType: 'image/png', contentDisposition: 'inline' },
        { content: 'second half', contentType: 'text/plain', contentDisposition: 'inline', filename: false },
      ],
    })

    uidMultipart = await appendFixture(seeder, multipart)
    uidHtmlOnly = await appendFixture(seeder, htmlOnly)
    uidBig = await appendFixture(seeder, big)
    uidLongBody = await appendFixture(seeder, longBody)
    uidInlineNamedBody = await appendFixture(seeder, inlineNamedBody)
    uidEmptyPlain = await appendFixture(seeder, emptyPlain)
    uidHtmlAsPlain = await appendFixture(seeder, htmlAsPlain)
    uidForwarded = await appendFixture(seeder, forwarded)
    uidSplit = await appendFixture(seeder, split)

    session = new ImapSession(testConfig())
  }, 120_000)

  afterAll(async () => {
    await session?.close()
    await seeder?.logout().catch(() => undefined)
    if (downloadDir) await rm(downloadDir, { recursive: true, force: true })
  })

  async function partIdFor(uid: number, filename: string): Promise<string> {
    const email = await getEmail(session, FOLDER, uid, 64)
    const match = email.attachments.find((a) => readUntrusted(a.filename) === filename)
    if (!match) throw new Error(`no attachment named ${filename} on uid ${uid}`)
    return match.partId
  }

  itIntegration('prefers the text/plain part and lists attachments with part ids', async () => {
    const email = await getEmail(session, FOLDER, uidMultipart, 64)

    expect(readUntrusted(email.body)).toContain('the plain part')
    expect(readUntrusted(email.body)).not.toContain('<b>')
    expect(email.bodyIsHtml).toBe(false)
    expect(email.bodyCutShort).toBe(false)

    expect(email.attachments).toHaveLength(2)
    const names = email.attachments.map((a) => readUntrusted(a.filename))
    expect(names).toEqual(['report.pdf', HOSTILE_FILENAME])
    for (const attachment of email.attachments) {
      expect(attachment.partId).toMatch(/^\d+(\.\d+)*$/)
      expect(attachment.sizeBytes).toBeGreaterThan(0)
    }
    expect(email.attachments[0].contentType).toBe('application/pdf')
  })

  itIntegration('maps envelope metadata onto the renderable email', async () => {
    const email = await getEmail(session, FOLDER, uidMultipart, 64)

    expect(email.folder).toBe(FOLDER)
    expect(email.uid).toBe(uidMultipart)
    expect(email.sizeBytes).toBeGreaterThan(5000)
    expect(email.sent).toBeInstanceOf(Date)
    expect(email.received).toBeInstanceOf(Date)
    expect(readUntrusted(email.cc)).toBe('')
    expect(readUntrusted(email.subject)).toBe('multipart fixture')
    expect(readUntrusted(email.from)).toBe(SENDER)
    for (const recipient of RECIPIENTS) expect(readUntrusted(email.to)).toContain(recipient)
  })

  itIntegration('falls back to HTML body and flags it', async () => {
    const email = await getEmail(session, FOLDER, uidHtmlOnly, 64)
    const body = readUntrusted(email.body)

    expect(email.bodyIsHtml).toBe(true)
    expect(body).toContain('only')
    expect(email.attachments).toEqual([])

    // A singlepart root carries no part id of its own, and imapflow treats an
    // absent part as "download the whole RFC822 source". That fallback still
    // satisfies a naive contains-check because the headers repeat the subject,
    // so pin that the body is the body and not the raw message.
    expect(body).not.toContain('Message-ID:')
    expect(body).not.toContain('MIME-Version:')
    expect(body.trim().startsWith('<p>')).toBe(true)
  })

  itIntegration('reading a message does not mark it \\Seen', async () => {
    await getEmail(session, FOLDER, uidMultipart, 64)

    const lock = await seeder!.getMailboxLock(FOLDER)
    try {
      const fetched = await seeder!.fetchOne(String(uidMultipart), { flags: true }, { uid: true })
      expect(fetched && fetched.flags?.has('\\Seen')).toBe(false)
    } finally {
      lock.release()
    }
  })

  itIntegration('unknown uid → ToolError not_found', async () => {
    await expect(getEmail(session, FOLDER, 999999, 64)).rejects.toMatchObject({ code: 'not_found' })
  })

  itIntegration('downloads an attachment byte-identical, with a sanitized unique name', async () => {
    const cfg = testConfig({ DOWNLOAD_DIR: downloadDir })
    const pdfPartId = await partIdFor(uidMultipart, 'report.pdf')

    const result = await getAttachment(session, cfg, FOLDER, uidMultipart, pdfPartId)

    expect(readFileSync(result.path)).toEqual(KNOWN_PDF_BYTES)
    expect(result.sizeBytes).toBe(KNOWN_PDF_BYTES.length)
    expect(result.contentType).toBe('application/pdf')
    expect(result.path.startsWith(downloadDir)).toBe(true)
    expect(basename(result.path)).toBe('report.pdf')
  })

  itIntegration('neutralizes a traversal filename and keeps the file inside the download dir', async () => {
    const cfg = testConfig({ DOWNLOAD_DIR: downloadDir })
    const hostilePartId = await partIdFor(uidMultipart, HOSTILE_FILENAME)

    const result = await getAttachment(session, cfg, FOLDER, uidMultipart, hostilePartId)

    expect(basename(result.path)).toBe('evil.sh')
    expect(result.path).toBe(join(downloadDir, 'evil.sh'))
    expect(readFileSync(result.path, 'utf8')).toContain('echo pwned')
  })

  itIntegration('a second download of the same attachment does not overwrite the first', async () => {
    const cfg = testConfig({ DOWNLOAD_DIR: downloadDir })
    const pdfPartId = await partIdFor(uidMultipart, 'report.pdf')

    const first = await getAttachment(session, cfg, FOLDER, uidMultipart, pdfPartId)
    const second = await getAttachment(session, cfg, FOLDER, uidMultipart, pdfPartId)

    expect(second.path).not.toBe(first.path)
    expect(readFileSync(first.path)).toEqual(KNOWN_PDF_BYTES)
    expect(readFileSync(second.path)).toEqual(KNOWN_PDF_BYTES)
  })

  itIntegration('uses an inline text part that carries a filename as the body, once', async () => {
    const email = await getEmail(session, FOLDER, uidInlineNamedBody, 64)

    // A filename alone must not disqualify a part from being the body, only
    // `disposition: attachment` does. Excluding on filename leaves this message
    // with an empty body and its own text listed as a downloadable file.
    expect(readUntrusted(email.body)).toContain(INLINE_BODY_TEXT)
    expect(email.bodyIsHtml).toBe(false)

    expect(email.attachments.map((a) => readUntrusted(a.filename))).toEqual(['invoice.pdf'])
  })

  itIntegration('creates a download directory that does not exist yet', async () => {
    const nested = join(downloadDir, 'nested', 'made-on-demand')
    const cfg = testConfig({ DOWNLOAD_DIR: nested })
    const pdfPartId = await partIdFor(uidMultipart, 'report.pdf')

    const result = await getAttachment(session, cfg, FOLDER, uidMultipart, pdfPartId)

    expect(result.path).toBe(join(nested, 'report.pdf'))
    expect(readFileSync(result.path)).toEqual(KNOWN_PDF_BYTES)
  })

  itIntegration('bounds a large body by DECODED bytes, so truncation stays predictable', async () => {
    const email = await getEmail(session, FOLDER, uidLongBody, 64)
    const bodyBytes = Buffer.byteLength(readUntrusted(email.body))

    // The body is base64-encoded on the wire (non-ASCII forces it), so this pins
    // WHICH octets imapflow's maxBytes counts: the decoded output, not the encoded
    // ones. Were it counting encoded octets, 65000 base64 chars would yield only
    // ~48750 bytes of text, landing under the 64 kB the renderer truncates at and
    // producing a short body with no marker.
    expect(bodyBytes).toBeGreaterThan(64_000)
    expect(bodyBytes).toBeLessThan(66_000)
    expect(email.bodyCutShort).toBe(true)
    expect(LONG_BODY_BYTES).toBeGreaterThan(100_000)
    expect(readUntrusted(email.body).startsWith('дд')).toBe(true)
  })

  itIntegration('unknown part id → ToolError not_found', async () => {
    const cfg = testConfig({ DOWNLOAD_DIR: downloadDir })
    await expect(getAttachment(session, cfg, FOLDER, uidMultipart, '9.9')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  itIntegration('declared size over cap → ToolError cap_exceeded BEFORE any download', async () => {
    const cfg = testConfig({ DOWNLOAD_DIR: downloadDir, MAX_ATTACHMENT_MB: '1' })
    const bigPartId = await partIdFor(uidBig, 'huge.bin')
    const filesBefore = readdirSync(downloadDir).sort()

    // The ordering IS the requirement: the cap has to be decided from the declared
    // bodystructure size, so no byte of the attachment may ever be requested.
    // Spying on the prototype is the only seam, because ImapSession constructs
    // its client lazily and privately.
    const spy = vi.spyOn(ImapFlow.prototype, 'download')
    try {
      const error = await getAttachment(session, cfg, FOLDER, uidBig, bigPartId).catch((e: Error) => e)
      expect(error).toMatchObject({ code: 'cap_exceeded' })
      // names the size, the cap and the variable that raises it
      expect((error as Error).message).toMatch(/1\.6 MB.*1 MB.*MAX_ATTACHMENT_MB/)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }

    expect(readdirSync(downloadDir).sort()).toEqual(filesBefore)
  })

  itIntegration('an attachment under the cap still downloads when a cap is set', async () => {
    const cfg = testConfig({ DOWNLOAD_DIR: downloadDir, MAX_ATTACHMENT_MB: '1' })
    const pdfPartId = await partIdFor(uidMultipart, 'report.pdf')

    const result = await getAttachment(session, cfg, FOLDER, uidMultipart, pdfPartId)
    expect(readFileSync(result.path)).toEqual(KNOWN_PDF_BYTES)
  })

  itIntegration('an empty plain alternative gives way to its html twin', async () => {
    const email = await getEmail(session, FOLDER, uidEmptyPlain, 64)
    expect(email.bodyIsHtml).toBe(true)
    expect(readUntrusted(email.body)).toContain('the real text')
    expect(email.attachments).toEqual([])
  })

  itIntegration('an HTML document sent as text/plain is inspected like HTML', async () => {
    const email = await getEmail(session, FOLDER, uidHtmlAsPlain, 64)
    expect(email.bodyIsHtml).toBe(true)
    const out = renderEmail(email, 64, testConfig().detect)
    expect(out).toMatch(/^Warnings: hidden_text \(/m)
    expect(out).not.toContain('<table')
  })

  itIntegration('a forwarded message is listed whole and its text is not the body', async () => {
    const email = await getEmail(session, FOLDER, uidForwarded, 64)
    expect(readUntrusted(email.body)).toContain('see the forwarded message')
    expect(email.attachments.map((a) => a.contentType)).toEqual(['message/rfc822'])
  })

  itIntegration('the second half of a split body is listed, not lost', async () => {
    const email = await getEmail(session, FOLDER, uidSplit, 64)
    expect(readUntrusted(email.body).trim()).toBe('first half')
    expect(email.attachments.map((a) => a.contentType)).toEqual(['image/png', 'text/plain'])
  })
})
