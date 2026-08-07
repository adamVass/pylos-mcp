import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { ImapFlow } from 'imapflow'
import { makeCoreApi, type CoreApi } from '../../src/core/api.js'
import { ImapSession } from '../../src/core/client.js'
import { deleteEmail, moveEmail, setFlags } from '../../src/core/mailbox-ops.js'
import { itIntegration, seedClient, testConfig } from './helpers.js'

// the search suite asserts absolute message counts on INBOX and Drafts, and
// suite order is not guaranteed
const FOLDER = 'T9Fixtures'
const DEST = 'T9Dest'

let uidCounter = 0
/** unique per message, so one can be found again after a move without relying on UID stability across folders */
function uniqueSubject(label: string): string {
  uidCounter += 1
  return `t9-${label}-${uidCounter}`
}

function message(subject: string): Buffer {
  return Buffer.from(
    [
      'From: Sender Name <sender@x.example>',
      'To: tester@x.example',
      `Subject: ${subject}`,
      'Date: Sun, 05 Jul 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\r\n'),
  )
}

describe('mailbox-ops against a local Dovecot container', () => {
  let session: ImapSession
  let core: CoreApi
  let seeder: ImapFlow

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    seeder = seedClient()
    seeder.on('error', () => {})
    await seeder.connect()
    await seeder.mailboxCreate(FOLDER).catch(() => undefined)
    await seeder.mailboxCreate(DEST).catch(() => undefined)

    session = new ImapSession(testConfig())
    core = makeCoreApi(testConfig({ CAPABILITIES: 'manage,delete' }), session)
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await seeder?.mailboxDelete(FOLDER).catch(() => undefined)
    await seeder?.mailboxDelete(DEST).catch(() => undefined)
    await seeder?.logout().catch(() => undefined)
  })

  async function seedOne(subject: string, folder = FOLDER): Promise<number> {
    const result = await seeder.append(folder, message(subject), [])
    if (!result || result.uid === undefined) throw new Error(`APPEND to ${folder} returned no UID`)

    // the connection under test may already have `folder` selected from an earlier
    // test, in which case it needs a NOOP before it can act by UID on a message
    // this connection just appended
    await session.withMailbox(folder, (client) => client.noop())

    return result.uid
  }

  /**
   * The NOOP is load-bearing: a message another connection moved is invisible
   * here until an untagged response announces it, and Dovecot only sends one
   * during a command that permits it.
   */
  async function withFolder<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    const lock = await seeder.getMailboxLock(folder)
    try {
      await seeder.noop()
      return await fn()
    } finally {
      lock.release()
    }
  }

  async function uidsIn(folder: string): Promise<number[]> {
    return withFolder(folder, async () => (await seeder.search({ all: true }, { uid: true })) || [])
  }

  /**
   * Matches on the client side rather than server-side SEARCH SUBJECT: in this
   * test image, a SUBJECT search issued by the verifying connection did not find
   * a message this suite had just moved there over a different connection, even
   * right after a fresh SELECT and NOOP, while comparing fetched envelopes did.
   */
  async function findBySubject(folder: string, subject: string): Promise<number | undefined> {
    return withFolder(folder, async () => {
      const uids = (await seeder.search({ all: true }, { uid: true })) || []
      for (const uid of uids) {
        const msg = await seeder.fetchOne(String(uid), { envelope: true }, { uid: true })
        if (msg && msg.envelope?.subject === subject) return uid
      }
      return undefined
    })
  }

  async function flagsOf(folder: string, uid: number): Promise<Set<string>> {
    return withFolder(folder, async () => {
      const msg = await seeder.fetchOne(String(uid), { flags: true }, { uid: true })
      if (!msg) throw new Error(`no message uid ${uid} in ${folder}`)
      return msg.flags ?? new Set<string>()
    })
  }

  /** the only suite that writes to the shared Trash folder, so it sweeps up after itself */
  async function removeFrom(folder: string, uids: number[]): Promise<void> {
    if (uids.length === 0) return
    await withFolder(folder, async () => {
      await seeder.messageDelete(uids, { uid: true })
    })
  }

  itIntegration('moveEmail moves; the message is gone from source and present in destination', async () => {
    const subject = uniqueSubject('move-ok')
    const uid = await seedOne(subject)

    await moveEmail(session, FOLDER, uid, DEST)

    expect(await uidsIn(FOLDER)).not.toContain(uid)
    expect(await findBySubject(DEST, subject)).toBeDefined()
  })

  itIntegration('moveEmail to a nonexistent folder throws, and the message is NOT removed from source', async () => {
    const subject = uniqueSubject('move-fail')
    const uid = await seedOne(subject)

    await expect(moveEmail(session, FOLDER, uid, 'T9DoesNotExist')).rejects.toMatchObject({ code: 'server' })

    expect(await uidsIn(FOLDER)).toContain(uid)
  })

  // imapflow's messageMove resolves truthy for a uid that matches nothing, since
  // Dovecot answers the same tagged OK it would for a real match, so a bare
  // `if (!moved)` check reports a no-op as a completed move.
  itIntegration('moveEmail on a uid that does not exist throws not_found, not a false success', async () => {
    await expect(moveEmail(session, FOLDER, 999_999, DEST)).rejects.toMatchObject({ code: 'not_found' })
  })

  itIntegration('setFlags sets and clears \\Seen and \\Flagged', async () => {
    const uid = await seedOne(uniqueSubject('flags'))

    await setFlags(session, FOLDER, uid, { seen: true, flagged: true })
    let flags = await flagsOf(FOLDER, uid)
    expect(flags.has('\\Seen')).toBe(true)
    expect(flags.has('\\Flagged')).toBe(true)

    await setFlags(session, FOLDER, uid, { seen: false, flagged: false })
    flags = await flagsOf(FOLDER, uid)
    expect(flags.has('\\Seen')).toBe(false)
    expect(flags.has('\\Flagged')).toBe(false)
  })

  itIntegration('setFlags on a uid that does not exist throws not_found, not a false success', async () => {
    await expect(setFlags(session, FOLDER, 999_999, { seen: true })).rejects.toMatchObject({ code: 'not_found' })
  })

  itIntegration('setFlags touches only the flag it is given', async () => {
    const uid = await seedOne(uniqueSubject('flags-partial'))

    await setFlags(session, FOLDER, uid, { seen: true })
    expect((await flagsOf(FOLDER, uid)).has('\\Seen')).toBe(true)
    expect((await flagsOf(FOLDER, uid)).has('\\Flagged')).toBe(false)

    await setFlags(session, FOLDER, uid, { flagged: true })
    expect((await flagsOf(FOLDER, uid)).has('\\Seen')).toBe(true)
    expect((await flagsOf(FOLDER, uid)).has('\\Flagged')).toBe(true)
  })

  itIntegration(
    'C-2 regression: deleteEmail moves to Trash — the message exists in Trash afterwards, not in source',
    async () => {
      const subject = uniqueSubject('delete-me')
      const uid = await seedOne(subject)

      const { trashFolder } = await deleteEmail(session, FOLDER, uid)
      expect(trashFolder).toBe('Trash')

      expect(await uidsIn(FOLDER)).not.toContain(uid)
      const trashUid = await findBySubject(trashFolder, subject)
      expect(trashUid).toBeDefined()

      await removeFrom(trashFolder, [trashUid!])
    },
  )

  // The seam's adapters are the one piece of wiring neither the unit tests nor
  // the MCP tests can see: a transposed argument in api.ts, or a capability
  // string that does not match server.ts, surfaces only against a real mailbox.
  itIntegration('moveEmail and deleteEmail reach the mailbox through the CoreApi seam', async () => {
    const moveSubject = uniqueSubject('seam-move')
    const moveUid = await seedOne(moveSubject)
    await core.moveEmail(FOLDER, moveUid, DEST)
    expect(await findBySubject(DEST, moveSubject)).toBeDefined()

    const deleteSubject = uniqueSubject('seam-delete')
    const deleteUid = await seedOne(deleteSubject)
    const { trashFolder } = await core.deleteEmail(FOLDER, deleteUid)
    const trashUid = await findBySubject(trashFolder, deleteSubject)
    expect(trashUid).toBeDefined()

    await removeFrom(trashFolder, [trashUid!])
  })
})
