import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import type { ImapSession } from '../../src/core/client.js'
import { makeCoreApi } from '../../src/core/api.js'
import { ComposeBudget, collectAttachments, createDraft } from '../../src/core/draft.js'
import { SendState, sendEmail } from '../../src/core/smtp.js'
import { ToolError } from '../../src/errors.js'
import { getAttachment } from '../../src/core/message.js'
import { fakeSession } from './helpers.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn((_file: string, _args: string[], _opts: object, done: (err: Error | null) => void) => done(null)),
  }
})

// Both cases need a server that misreports its own BODYSTRUCTURE, which the
// Dovecot harness cannot be made to do: it always declares a size, and always the
// right one.
function stubSession(
  node: Record<string, unknown>,
  body: Iterable<Buffer>,
): { session: ImapSession; download: ReturnType<typeof vi.fn> } {
  const download = vi.fn(async () => ({
    content: Readable.from(body),
    meta: { contentType: 'application/pdf' },
  }))
  const client = {
    fetchOne: async () => ({ uid: 7, bodyStructure: node }),
    download,
  }

  return { session: fakeSession(client), download }
}

function config(downloadDir: string) {
  return loadConfig({
    EMAIL_USER: 'a@mailbox.org',
    EMAIL_PASSWORD: 'pw',
    PROVIDER: 'mailbox.org',
    MAX_ATTACHMENT_MB: '1',
    DOWNLOAD_DIR: downloadDir,
  })
}

const PART = {
  part: '1',
  type: 'application/pdf',
  disposition: 'attachment',
  dispositionParameters: { filename: 'report.pdf' },
}

describe('the attachment cap does not trust the declared size', () => {
  // `size ?? 0` used to make a part with no declared size look like a 0-byte
  // one, which passes any cap. The download that followed had no bound at all.
  it('refuses a part the server declared no size for, before downloading it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pylos-cap-'))
    const { session, download } = stubSession({ ...PART, size: undefined }, [])

    await expect(getAttachment(session, config(dir), 'INBOX', 7, '1')).rejects.toMatchObject({
      code: 'cap_exceeded',
    })
    expect(download).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  // The declared size is the server's claim. A server that understates it gets
  // stopped mid-transfer instead of writing an unbounded file.
  it('aborts a transfer that runs past the cap and leaves no partial file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pylos-cap-'))
    const oversized = Array.from({ length: 3 }, () => Buffer.alloc(500_000, 0x41))
    const { session } = stubSession({ ...PART, size: 100 }, oversized)

    await expect(getAttachment(session, config(dir), 'INBOX', 7, '1')).rejects.toMatchObject({
      code: 'cap_exceeded',
    })
    expect(readdirSync(dir)).toEqual([])
  })

  // The draft and send paths hold the part in MEMORY rather than streaming it to
  // disk, so this bound is the only thing standing between an understating server
  // and however much heap it feels like taking. The generator offers 500 MB, and
  // what matters is that only a bounded prefix of it is ever pulled.
  it('stops an oversized part before it is all in memory', async () => {
    let yielded = 0
    function* endlessChunks(): Generator<Buffer> {
      for (let i = 0; i < 1000; i++) {
        yielded += 1
        yield Buffer.alloc(500_000, 0x41)
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'pylos-cap-'))
    const { session } = stubSession({ ...PART, size: 100 }, endlessChunks())

    await expect(
      collectAttachments(session, config(dir), [{ folder: 'INBOX', uid: 7, partId: '1' }], new ComposeBudget()),
    ).rejects.toMatchObject({ code: 'cap_exceeded' })

    expect(yielded).toBeLessThan(50)
  })
})

describe('saving an attachment', () => {
  const realPlatform = process.platform
  const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })
  const xattr = vi.mocked(execFile)
  const succeed = ((_file: string, _args: string[], _opts: object, done: (err: Error | null) => void) =>
    done(null)) as never

  beforeEach(() => {
    xattr.mockReset()
    xattr.mockImplementation(succeed)
  })
  afterEach(() => {
    onPlatform(realPlatform)
    xattr.mockReset()
    xattr.mockImplementation(succeed)
  })

  it('writes the file readable by its owner only, and leaves xattr alone off macOS', async () => {
    onPlatform('linux')
    const dir = mkdtempSync(join(tmpdir(), 'pylos-save-'))
    const { session } = stubSession({ ...PART, size: 5 }, [Buffer.from('hello')])

    const saved = await getAttachment(session, config(dir), 'INBOX', 7, '1')

    expect(statSync(saved.path).mode & 0o777).toBe(0o600)
    expect(xattr).not.toHaveBeenCalled()
  })

  it('on macOS, quarantines the file before its first byte is written', async () => {
    onPlatform('darwin')
    let sizeWhenFlagged = -1
    xattr.mockImplementation(((_file: string, args: string[], _opts: object, done: (err: Error | null) => void) => {
      sizeWhenFlagged = statSync(args[3]).size
      done(null)
    }) as never)
    const dir = mkdtempSync(join(tmpdir(), 'pylos-save-'))
    const { session } = stubSession({ ...PART, size: 5 }, [Buffer.from('hello')])

    const saved = await getAttachment(session, config(dir), 'INBOX', 7, '1')

    expect(xattr).toHaveBeenCalledWith(
      '/usr/bin/xattr',
      ['-w', 'com.apple.quarantine', expect.stringMatching(/^0081;[0-9a-f]+;pylos-mcp;$/), saved.path],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    )
    expect(sizeWhenFlagged).toBe(0)
  })

  it('on macOS, a file that cannot be quarantined is not kept', async () => {
    onPlatform('darwin')
    xattr.mockImplementation(((_file: string, _args: string[], _opts: object, done: (err: Error | null) => void) =>
      done(new Error('operation not permitted'))) as never)
    const dir = mkdtempSync(join(tmpdir(), 'pylos-save-'))
    const { session } = stubSession({ ...PART, size: 5 }, [Buffer.from('hello')])

    await expect(getAttachment(session, config(dir), 'INBOX', 7, '1')).rejects.toMatchObject({ code: 'policy' })
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('the compose budget', () => {
  const REF = { folder: 'INBOX', uid: 7, partId: '1' }
  const TOGETHER =
    'the attachments together are larger than MAX_ATTACHMENT_MB (1 MB) allows for one message. Nothing was saved or sent'
  const BUSY = 'another message with attachments is being composed right now. Try again when it has finished'

  const part = (size: number) => stubSession({ ...PART, size }, [Buffer.alloc(size, 0x41)])
  const cfg = () => config(mkdtempSync(join(tmpdir(), 'pylos-budget-')))

  it('refuses parts that together pass the budget, and gives back what it had reserved', async () => {
    const budget = new ComposeBudget()
    const { session } = part(600_000)
    await expect(collectAttachments(session, cfg(), [REF, REF], budget)).rejects.toThrow(TOGETHER)
    expect(budget.reserved).toBe(0)
  })

  it('refuses a composition while another holds the budget, and admits it once that one releases', async () => {
    const budget = new ComposeBudget()
    const { session } = part(600_000)

    const first = await collectAttachments(session, cfg(), [REF], budget)
    await expect(collectAttachments(session, cfg(), [REF], budget)).rejects.toThrow(BUSY)
    first.release()
    expect(budget.reserved).toBe(0)

    const third = await collectAttachments(session, cfg(), [REF], budget)
    expect(budget.reserved).toBe(600_000)
    third.release()
  })

  // imapflow transcodes inline text to UTF-8, so an honest part can outgrow its declaration
  it('charges bytes past the declared size instead of refusing them', async () => {
    const budget = new ComposeBudget()
    const { session } = stubSession({ ...PART, size: 1000 }, [Buffer.alloc(1200, 0x41), Buffer.alloc(300, 0x41)])
    const collected = await collectAttachments(session, cfg(), [REF], budget)
    expect(collected.attachments[0].content).toHaveLength(1500)
    expect(budget.reserved).toBe(1500)
    collected.release()
    expect(budget.reserved).toBe(0)
  })

  // one budget for the whole server, held until the APPEND settles, not just until compose
  it('drafts made through one CoreApi share the budget until the APPEND settles', async () => {
    let finishAppend: (result: { uid: number }) => void = () => {}
    const held = new Promise<{ uid: number }>((resolve) => {
      finishAppend = resolve
    })
    let appends = 0
    const client = {
      fetchOne: async () => ({ uid: 7, bodyStructure: { ...PART, size: 600_000 } }),
      download: async () => ({ content: Readable.from([Buffer.alloc(600_000)]), meta: {} }),
      append: () => {
        appends += 1
        return appends === 1 ? held : Promise.resolve({ uid: 9 })
      },
    }
    const session = {
      withMailbox: <T>(_path: string, fn: (c: never) => Promise<T>) => fn(client as never),
      specialUse: async () => 'Drafts',
    } as unknown as ImapSession
    const core = makeCoreApi(cfg(), session)
    const draft = { subject: 's', body: 'b', attachments: [REF] }

    const first = core.createDraft(draft)
    await vi.waitFor(() => expect(appends).toBe(1))
    await expect(core.createDraft(draft)).rejects.toThrow(BUSY)

    finishAppend({ uid: 8 })
    await first
    await expect(core.createDraft(draft)).resolves.toMatchObject({ uid: 9 })
  })

  it('a draft whose APPEND fails gives its reservation back', async () => {
    const budget = new ComposeBudget()
    const client = {
      fetchOne: async () => ({ uid: 7, bodyStructure: { ...PART, size: 1000 } }),
      download: async () => ({ content: Readable.from([Buffer.alloc(1000)]), meta: {} }),
      append: async () => {
        throw new Error('NO [OVERQUOTA]')
      },
    }
    const session = {
      withMailbox: <T>(_path: string, fn: (c: never) => Promise<T>) => fn(client as never),
      specialUse: async () => 'Drafts',
    } as unknown as ImapSession

    await expect(
      createDraft(session, cfg(), { subject: 's', body: 'b', attachments: [REF] }, budget),
    ).rejects.toBeInstanceOf(ToolError)
    expect(budget.reserved).toBe(0)
  })

  it('a send the relay never takes gives its reservation back', async () => {
    const budget = new ComposeBudget()
    const { session } = part(1000)
    const sendCfg = loadConfig({
      EMAIL_USER: 'a@x.example',
      EMAIL_PASSWORD: 'pw',
      IMAP_HOST: 'localhost',
      CAPABILITIES: 'send',
      SMTP_HOST: '127.0.0.1',
      // nothing listens on port 1, so the connection is refused at once
      SMTP_PORT: '1',
      SEND_ALLOWLIST: '*',
      MAX_ATTACHMENT_MB: '1',
    })

    await expect(
      sendEmail(
        session,
        sendCfg,
        new SendState(),
        { to: ['b@x.example'], subject: 's', body: 'b', attachments: [REF] },
        budget,
      ),
    ).rejects.toBeInstanceOf(ToolError)
    expect(budget.reserved).toBe(0)
  })
})
