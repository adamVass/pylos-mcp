import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import type { ImapSession } from '../../src/core/client.js'
import { collectAttachments } from '../../src/core/draft.js'
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
      collectAttachments(session, config(dir), [{ folder: 'INBOX', uid: 7, partId: '1' }]),
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
