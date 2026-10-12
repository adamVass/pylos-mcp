import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { ImapFlow } from 'imapflow'
import { ImapSession } from '../../src/core/client.js'
import { getThread } from '../../src/core/thread.js'
import { readUntrusted } from '../../src/safety/untrusted.js'
import { itIntegration, rawMessage, seedClient, testConfig } from './helpers.js'

const FOLDER = 'ThreadFixtures'
const OTHER = 'ThreadOther'

// received dates, not Date headers, decide the order, so these run against arrival order
const received = (day: number) => new Date(Date.UTC(2026, 9, day))

describe('getThread against a local Dovecot container', () => {
  let session: ImapSession
  let seeder: ImapFlow | undefined
  const uids: Record<string, number> = {}

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return
    seeder = await seedClient()
    for (const folder of [FOLDER, OTHER]) {
      await seeder.mailboxCreate(folder).catch(() => undefined)
      const { messages } = await seeder.status(folder, { messages: true })
      if (messages !== 0) throw new Error(`${folder} must be empty before seeding, found ${messages} message(s)`)
    }

    const append = async (name: string, folder: string, day: number, headers: string[]) => {
      const result = await seeder?.append(
        folder,
        rawMessage({ subject: name.replace('-copy', ''), from: 'Sender <sender@x.example>', headers }),
        [],
        received(day),
      )
      if (!result || result.uid === undefined) throw new Error(`APPEND of ${name} returned no UID`)
      uids[name] = result.uid
    }
    await append('root', FOLDER, 1, ['Message-ID: <root@x.example>'])
    await append('unrelated', FOLDER, 2, ['Message-ID: <other@x.example>'])
    // the reply sits in both folders, as a sent reply does in Sent and the recipient's copy elsewhere
    const reply = ['Message-ID: <reply@x.example>', 'In-Reply-To: <root@x.example>', 'References: <root@x.example>']
    await append('reply', OTHER, 3, reply)
    await append('reply-copy', FOLDER, 3, reply)
    await append('second reply', FOLDER, 5, [
      'Message-ID: <second@x.example>',
      'In-Reply-To: <reply@x.example>',
      'References: <root@x.example> <reply@x.example>',
    ])
    // a reply whose client kept only In-Reply-To, the way some mobile clients do
    await append('bare reply', FOLDER, 4, ['Message-ID: <bare@x.example>', 'In-Reply-To: <root@x.example>'])
    await append('no id', FOLDER, 6, [])

    session = new ImapSession(testConfig())
  })

  afterAll(async () => {
    await session?.close()
    for (const folder of [FOLDER, OTHER]) await seeder?.mailboxDelete(folder).catch(() => undefined)
    await seeder?.logout().catch(() => undefined)
  })

  const subjects = (items: { subject: Parameters<typeof readUntrusted>[0] }[]) =>
    items.map((item) => readUntrusted(item.subject))

  itIntegration('gathers the conversation from any member, across folders, oldest first and once each', async () => {
    for (const from of ['root', 'second reply']) {
      const { items, omitted } = await getThread(session, FOLDER, uids[from], [OTHER])
      expect(subjects(items)).toEqual(['root', 'reply', 'bare reply', 'second reply'])
      expect(omitted).toBe(0)
    }
  })

  itIntegration('the copy in the asked folder is the one listed', async () => {
    const { items } = await getThread(session, FOLDER, uids['second reply'], [OTHER])
    expect(items.find((item) => readUntrusted(item.subject) === 'reply')).toMatchObject({
      folder: FOLDER,
      uid: uids['reply-copy'],
    })
  })

  itIntegration(
    'keeps the newest when the thread is longer than the limit, and says how many were left out',
    async () => {
      const { items, omitted } = await getThread(session, FOLDER, uids.root, [OTHER], 2)
      expect(subjects(items)).toEqual(['bare reply', 'second reply'])
      expect(omitted).toBe(2)
    },
  )

  itIntegration('a folder with more matches than it fetches makes the count a lower bound', async () => {
    expect((await getThread(session, FOLDER, uids.root, [OTHER])).capped).toBe(false)
    expect((await getThread(session, FOLDER, uids.root, [OTHER], 50, 2)).capped).toBe(true)
  })

  itIntegration('a message without a Message-ID is a thread of one', async () => {
    const { items, omitted } = await getThread(session, FOLDER, uids['no id'], [OTHER])
    expect(subjects(items)).toEqual(['no id'])
    expect(omitted).toBe(0)
  })

  itIntegration('a missing extra folder is skipped, and an unknown uid is not_found', async () => {
    const { items } = await getThread(session, FOLDER, uids.root, ['NoSuchFolderHere'])
    expect(subjects(items)).toEqual(['root', 'reply', 'bare reply', 'second reply'])
    await expect(getThread(session, FOLDER, 999999, [])).rejects.toMatchObject({ code: 'not_found' })
  })
})
