import { afterAll, beforeAll, expect } from 'vitest'
import type { ImapFlow } from 'imapflow'
import { makeCoreApi, type CoreApi } from '../../src/core/api.js'
import { ImapSession } from '../../src/core/client.js'
import { itIntegration, seedClient, testConfig } from './helpers.js'

// the search suite asserts absolute message counts on INBOX and Drafts and
// refuses to seed if either is already occupied
const FOLDER = 'T8Fixtures'
const SUBJECT = 'seam-fixture'
const BODY = 'the body the seam must hand back'

const message = Buffer.from(
  [
    'From: Sender Name <sender@x.example>',
    'To: tester@x.example',
    `Subject: ${SUBJECT}`,
    'Date: Sun, 05 Jul 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    BODY,
    '',
  ].join('\r\n'),
)

let session: ImapSession
let core: CoreApi
let seeder: ImapFlow

beforeAll(async () => {
  if (!process.env.RUN_INTEGRATION) return

  seeder = seedClient()
  seeder.on('error', () => {})
  await seeder.connect()
  await seeder.mailboxCreate(FOLDER).catch(() => undefined)
  await seeder.append(FOLDER, message, [])

  const cfg = testConfig()
  session = new ImapSession(cfg)
  core = makeCoreApi(cfg, session)
}, 60_000)

afterAll(async () => {
  await session?.close()
  await seeder?.mailboxDelete(FOLDER).catch(() => undefined)
  await seeder?.logout().catch(() => undefined)
})

itIntegration('listFolders reports the folder tree with message counts from a real server', async () => {
  const folders = await core.listFolders()

  const inbox = folders.find((f) => f.path === 'INBOX')
  expect(inbox).toBeDefined()
  // the count came from a STATUS the server had to answer, not from a default
  expect(typeof inbox?.messages).toBe('number')

  const drafts = folders.find((f) => f.specialUse === '\\Drafts')
  expect(drafts?.path).toBe('Drafts')
})

// The MCP tests inject a fake core, so a transposed argument in the seam's
// adapters would first surface against a real mailbox.
itIntegration('searchEmails and getEmail reach the right message through the seam', async () => {
  const { total, items } = await core.searchEmails({ folder: FOLDER, limit: 5, offset: 0 })
  expect(total).toBe(1)

  const found = items[0]
  expect(found.folder).toBe(FOLDER)

  const email = await core.getEmail(FOLDER, found.uid)
  expect(email.folder).toBe(FOLDER)
  expect(email.uid).toBe(found.uid)
})

itIntegration('getAttachment resolves folder, uid and part id in that order', async () => {
  const { items } = await core.searchEmails({ folder: FOLDER, limit: 1, offset: 0 })
  const uid = items[0].uid

  // a transposition would fail on the mailbox instead ("no mailbox named ..."),
  // so the part-level complaint is what proves each argument reached its slot
  await expect(core.getAttachment(FOLDER, uid, 'no-such-part')).rejects.toThrow(/no such part/)
})
