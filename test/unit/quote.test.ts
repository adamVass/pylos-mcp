import { expect, it } from 'vitest'
import { ComposeBudget, prepareBody } from '../../src/core/draft.js'
import { SendState, sendEmail } from '../../src/core/smtp.js'
import type { SendProposal } from '../../src/safety/outgoing.js'
import { confirmSendConfig, fakeClient, fakeSession } from './helpers.js'

const REF = { folder: 'INBOX', uid: 7 }
const QUOTED = 'Thanks\n\nOn Wed, 14 Oct 2026 09:12:00 GMT, Ann <ann@x.example> wrote:\n> hello'

const cfg = confirmSendConfig({ EMAIL_USER: 'me@x.example', CAPABILITIES: 'drafts,send' })

function original(body = 'hello\r\n') {
  const events: string[] = []
  const client = fakeClient({
    events,
    body: [Buffer.from(body)],
    message: {
      uid: 7,
      headers: Buffer.from('Message-ID: <orig@x.example>\r\n\r\n'),
      envelope: {
        date: new Date('2026-10-14T09:12:00Z'),
        from: [{ name: 'Ann', address: 'ann@x.example' }],
        to: [{ address: 'bob@x.example' }],
        replyTo: [{ address: 'list@x.example' }],
      },
      bodyStructure: { part: '1', type: 'text/plain', size: Buffer.byteLength(body) },
    },
  })
  return { events, session: fakeSession(client) }
}

const reply = { subject: 'Re: s', body: 'Thanks', inReplyTo: REF, quoteOriginal: true }

it('a quoted reply carries the original below the body and threads to it', async () => {
  const { session } = original()
  const prepared = await prepareBody(session, cfg, {
    ...reply,
    to: ['ANN@x.example', 'me@x.example'],
    cc: ['list@x.example'],
  })
  expect(prepared).toEqual({
    body: QUOTED,
    thread: { inReplyTo: '<orig@x.example>', references: ['<orig@x.example>'] },
  })
})

it('a recipient who was not on the original is refused before the body is downloaded', async () => {
  const { events, session } = original()
  const refused = prepareBody(session, cfg, { ...reply, to: ['ann@x.example', 'eve@x.example'] })
  await expect(refused).rejects.toThrow(/recipients were not on it: eve@x\.example\. Nothing was saved/)
  expect(events).toEqual(['fetch'])
})

it('an original too long to quote whole is refused, not cut', async () => {
  const { session } = original('x'.repeat(600_000))
  await expect(prepareBody(session, cfg, { ...reply, to: ['ann@x.example'] })).rejects.toThrow(
    /too long to quote whole/,
  )
})

it('quote_original without in_reply_to, and a long body with no quote, are refused before any IMAP work', async () => {
  const { events, session } = original()
  await expect(prepareBody(session, cfg, { subject: 's', body: 'b', quoteOriginal: true })).rejects.toThrow(
    /needs in_reply_to/,
  )
  await expect(prepareBody(session, cfg, { subject: 's', body: 'x'.repeat(64_001) })).rejects.toThrow(
    'the message body is 65 kB, over the 64 kB limit',
  )
  expect(events).toEqual([])
})

it('the owner is shown the quote and its source, and the original is not read again after they accept', async () => {
  const { events, session } = original()
  let shown: SendProposal | undefined
  const send = sendEmail(
    session,
    cfg,
    new SendState(),
    { ...reply, to: ['ann@x.example'] },
    new ComposeBudget(),
    async (p) => {
      shown = p
      events.push('confirm')
      return true
    },
  )
  await expect(send).rejects.toMatchObject({ code: 'connect' })
  expect(events).toEqual(['fetch', 'download', 'confirm'])
  expect(shown).toMatchObject({ body: QUOTED, quotedFrom: REF })
})

it('a client that cannot show the dialog is refused before the original is read', async () => {
  const { events, session } = original()
  const send = sendEmail(session, cfg, new SendState(), { ...reply, to: ['ann@x.example'] }, new ComposeBudget())
  await expect(send).rejects.toThrow(/cannot show a confirmation dialog/)
  expect(events).toEqual([])
})
