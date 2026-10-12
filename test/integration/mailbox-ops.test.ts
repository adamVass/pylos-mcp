import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { ImapFlow } from 'imapflow'
import { makeCoreApi, type CoreApi } from '../../src/core/api.js'
import { ImapSession } from '../../src/core/client.js'
import { deleteEmail, moveEmail, setFlags } from '../../src/core/mailbox-ops.js'
import { flagsOf, inMailbox, itIntegration, rawMessage, seedClient, testConfig, uidsIn } from './helpers.js'

const FOLDER = 'T9Fixtures'
const DEST = 'T9Dest'

let uidCounter = 0
/** unique per message, so one can be found again after a move without relying on UID stability across folders */
function uniqueSubject(label: string): string {
  uidCounter += 1
  return `t9-${label}-${uidCounter}`
}

const message = (subject: string) => rawMessage({ subject, date: new Date(Date.UTC(2026, 6, 5, 10)) })

describe('mailbox-ops against a local Dovecot container', () => {
  let session: ImapSession
  let core: CoreApi
  let seeder: ImapFlow

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return

    seeder = await seedClient()
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

    // the connection under test may already have `folder` selected, and needs a NOOP before acting
    // by UID on a message this connection just appended
    await session.withMailbox(folder, (client) => client.noop())

    return result.uid
  }

  /**
   * matches client side because a SUBJECT search from the verifying connection did not find a
   * message just moved over another connection, while comparing fetched envelopes did
   */
  async function findBySubject(folder: string, subject: string): Promise<number | undefined> {
    return inMailbox(seeder, folder, async () => {
      const uids = (await seeder.search({ all: true }, { uid: true })) || []
      for (const uid of uids) {
        const msg = await seeder.fetchOne(String(uid), { envelope: true }, { uid: true })
        if (msg && msg.envelope?.subject === subject) return uid
      }
      return undefined
    })
  }

  /** the only suite that writes to the shared Trash folder, so it sweeps up after itself */
  async function removeFrom(folder: string, uids: number[]): Promise<void> {
    if (uids.length === 0) return
    await inMailbox(seeder, folder, async () => {
      await seeder.messageDelete(uids, { uid: true })
    })
  }

  itIntegration('moveEmail moves; the message is gone from source and present in destination', async () => {
    const subject = uniqueSubject('move-ok')
    const uid = await seedOne(subject)

    await moveEmail(session, FOLDER, uid, DEST)

    expect(await uidsIn(seeder, FOLDER)).not.toContain(uid)
    expect(await findBySubject(DEST, subject)).toBeDefined()
  })

  itIntegration('moveEmail to a nonexistent folder throws, and the message is NOT removed from source', async () => {
    const subject = uniqueSubject('move-fail')
    const uid = await seedOne(subject)

    await expect(moveEmail(session, FOLDER, uid, 'T9DoesNotExist')).rejects.toMatchObject({ code: 'server' })

    expect(await uidsIn(seeder, FOLDER)).toContain(uid)
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
    let flags = await flagsOf(seeder, FOLDER, uid)
    expect(flags.has('\\Seen')).toBe(true)
    expect(flags.has('\\Flagged')).toBe(true)

    await setFlags(session, FOLDER, uid, { seen: false, flagged: false })
    flags = await flagsOf(seeder, FOLDER, uid)
    expect(flags.has('\\Seen')).toBe(false)
    expect(flags.has('\\Flagged')).toBe(false)
  })

  itIntegration('setFlags on a uid that does not exist throws not_found, not a false success', async () => {
    await expect(setFlags(session, FOLDER, 999_999, { seen: true })).rejects.toMatchObject({ code: 'not_found' })
  })

  itIntegration('setFlags touches only the flag it is given', async () => {
    const uid = await seedOne(uniqueSubject('flags-partial'))

    await setFlags(session, FOLDER, uid, { seen: true })
    expect((await flagsOf(seeder, FOLDER, uid)).has('\\Seen')).toBe(true)
    expect((await flagsOf(seeder, FOLDER, uid)).has('\\Flagged')).toBe(false)

    await setFlags(session, FOLDER, uid, { flagged: true })
    expect((await flagsOf(seeder, FOLDER, uid)).has('\\Seen')).toBe(true)
    expect((await flagsOf(seeder, FOLDER, uid)).has('\\Flagged')).toBe(true)
  })

  itIntegration(
    'C-2 regression: deleteEmail moves to Trash — the message exists in Trash afterwards, not in source',
    async () => {
      const subject = uniqueSubject('delete-me')
      const uid = await seedOne(subject)

      const { trashFolder } = await deleteEmail(session, FOLDER, uid)
      expect(trashFolder).toBe('Trash')

      expect(await uidsIn(seeder, FOLDER)).not.toContain(uid)
      const trashUid = await findBySubject(trashFolder, subject)
      expect(trashUid).toBeDefined()

      await removeFrom(trashFolder, [trashUid!])
    },
  )

  // a transposed argument in api.ts or a capability string not matching server.ts surfaces only against a real mailbox
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
