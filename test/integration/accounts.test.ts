import { randomUUID } from 'node:crypto'
import { describe, expect } from 'vitest'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { openAccounts } from '../../src/core/api.js'
import { ToolError } from '../../src/errors.js'
import { readUntrusted } from '../../src/safety/untrusted.js'
import { KNOWN_PDF_BYTES, itIntegration, seedClient, testConfig } from './helpers.js'

const alice = () => testConfig({ EMAIL_USER: 'alice', CAPABILITIES: 'read,drafts' })
const bob = (over: Record<string, string> = {}) =>
  testConfig({ EMAIL_USER: 'bob', CAPABILITIES: 'read,drafts', ...over })

const build = (mail: ConstructorParameters<typeof MailComposer>[0]) =>
  new Promise<Buffer>((resolve, reject) =>
    new MailComposer(mail).compile().build((err, msg) => (err ? reject(err) : resolve(msg))),
  )

async function seed(cfg: ReturnType<typeof testConfig>, mail: Parameters<typeof build>[0]) {
  const folder = `accounts-${randomUUID()}`
  const client = await seedClient(cfg)
  try {
    await client.mailboxCreate(folder)
    const result = await client.append(folder, await build(mail), [])
    if (!result || result.uid === undefined) throw new Error('APPEND returned no UID')
    return { folder, uid: result.uid }
  } finally {
    await client.logout()
  }
}

const mail = (subject: string, extra = {}) => ({
  from: 'x@x.example',
  to: 'y@x.example',
  subject,
  text: 'hi',
  ...extra,
})
const NO_FOLDER = (folder: string) => `no mailbox named "${folder}" on the server`

describe('accounts in one server', () => {
  itIntegration('each account reads its own message at the same folder and uid', async () => {
    const folder = `accounts-${randomUUID()}`
    const uids: number[] = []
    for (const [cfg, subject] of [
      [alice(), 'for alice'],
      [bob(), 'for bob'],
    ] as const) {
      const client = await seedClient(cfg)
      try {
        await client.mailboxCreate(folder)
        const r = await client.append(folder, await build(mail(subject)), [])
        uids.push(r ? (r.uid as number) : -1)
      } finally {
        await client.logout()
      }
    }
    expect(uids[0]).toBe(uids[1])
    const { accounts, close } = openAccounts([
      { name: 'alice', cfg: alice() },
      { name: 'bob', cfg: bob() },
    ])
    try {
      const [a, b] = await Promise.all(accounts.map((x) => x.core.getEmail(folder, uids[0])))
      expect([readUntrusted(a.subject), readUntrusted(b.subject)]).toEqual(['for alice', 'for bob'])
    } finally {
      await close()
    }
  })

  itIntegration('a draft cannot attach a part from another account', async () => {
    const { folder, uid } = await seed(
      alice(),
      mail('with pdf', {
        attachments: [{ filename: 'r.pdf', content: KNOWN_PDF_BYTES, contentType: 'application/pdf' }],
      }),
    )
    const { accounts, close } = openAccounts([
      { name: 'alice', cfg: alice() },
      { name: 'bob', cfg: bob() },
    ])
    try {
      const err = await accounts[1].core
        .createDraft({ to: ['y@x.example'], subject: 's', body: 'b', attachments: [{ folder, uid, partId: '2' }] })
        .catch((e) => e)
      expect(err).toBeInstanceOf(ToolError)
      expect(err.message).toBe(NO_FOLDER(folder))
    } finally {
      await close()
    }
  })

  itIntegration('a draft cannot reply to a message in another account', async () => {
    const { folder, uid } = await seed(alice(), mail('private'))
    const { accounts, close } = openAccounts([
      { name: 'alice', cfg: alice() },
      { name: 'bob', cfg: bob() },
    ])
    try {
      const err = await accounts[1].core
        .createDraft({ to: ['y@x.example'], subject: 's', body: 'b', inReplyTo: { folder, uid } })
        .catch((e) => e)
      expect(err).toBeInstanceOf(ToolError)
      expect(err.message).toBe(NO_FOLDER(folder))
    } finally {
      await close()
    }
  })

  itIntegration('one account with a wrong password leaves the other working', async () => {
    const { accounts, close } = openAccounts([
      { name: 'alice', cfg: alice() },
      { name: 'bob', cfg: bob({ EMAIL_PASSWORD: 'wrong' }) },
    ])
    try {
      await expect(accounts[1].core.listFolders()).rejects.toThrow(/^authentication failed/)
      await expect(accounts[0].core.listFolders()).resolves.toBeDefined()
    } finally {
      await close()
    }
  })
})
