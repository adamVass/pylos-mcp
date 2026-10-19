import { expect, it } from 'vitest'
import { makeCoreApi } from '../../src/core/api.js'
import { ComposeBudget } from '../../src/core/draft.js'
import { type Confirm, SendState, sendEmail } from '../../src/core/smtp.js'
import type { SendProposal } from '../../src/safety/outgoing.js'
import { confirmSendConfig, fakeClient, fakeSession } from './helpers.js'

const REF = { folder: 'INBOX', uid: 7, partId: '1' }
const ARGS = { to: ['b@x.example'], subject: 's', body: 'b', attachments: [REF] }

const cfg = confirmSendConfig({ SEND_SESSION_CAP: '2' })

/** records the order of IMAP work against the dialog */
function harness() {
  const events: string[] = []
  const client = fakeClient({
    events,
    body: [Buffer.alloc(1000)],
    meta: { contentType: 'application/pdf' },
    message: {
      uid: 7,
      bodyStructure: {
        part: '1',
        type: 'application/pdf',
        size: 1000,
        disposition: 'attachment',
        dispositionParameters: { filename: 'report.pdf' },
      },
    },
  })
  const state = new SendState()
  const send = (confirm?: Confirm, args = ARGS) =>
    sendEmail(fakeSession(client), cfg, state, args, new ComposeBudget(), confirm)
  return { events, state, send, client }
}

it('a client that cannot show the dialog is refused before any IMAP work', async () => {
  const { events, state, send } = harness()
  await expect(send(undefined)).rejects.toThrow(/cannot show a confirmation dialog.*create_draft/)
  expect(events).toEqual([])
  expect(state).toMatchObject({ sent: 0, inFlight: 0, confirming: false })
})

it('the owner is shown each attachment before any byte of it is downloaded', async () => {
  const { events, send } = harness()
  let shown: SendProposal | undefined
  await expect(
    send(async (proposal) => {
      shown = proposal
      events.push('confirm')
      return true
    }),
  ).rejects.toMatchObject({ code: 'connect' })

  expect(events).toEqual(['fetch', 'confirm', 'fetch', 'download'])
  expect(shown).toEqual({
    from: 'a@x.example',
    to: ['b@x.example'],
    cc: [],
    subject: 's',
    body: 'b',
    attachments: [{ filename: 'report.pdf', declaredBytes: 1000, encoding: undefined, folder: 'INBOX', uid: 7 }],
    inReplyTo: undefined,
  })
})

it.each([
  ['declined', async () => false],
  ['never answered', async () => Promise.reject(new Error('dialog failed'))],
])('a dialog the owner %s sends nothing and spends no slot', async (_name, confirm) => {
  const { events, state, send } = harness()
  await expect(send(confirm)).rejects.toThrow(/did not accept this message/)
  expect(events).toEqual(['fetch'])
  expect(state).toMatchObject({ sent: 0, inFlight: 0, confirming: false })
})

it('the allowlist and a spent cap refuse without asking the owner', async () => {
  const { state, send } = harness()
  let asked = 0
  const confirm = async () => {
    asked += 1
    return true
  }
  await expect(send(confirm, { ...ARGS, to: ['b@evil.example'] })).rejects.toThrow(/not in SEND_ALLOWLIST/)
  state.sent = 2
  await expect(send(confirm)).rejects.toThrow(/session send cap reached/)
  expect(asked).toBe(0)
})

// the owner may take minutes, and other sends can spend the cap meanwhile
it('the cap is checked again after the owner accepts', async () => {
  const { events, state, send } = harness()
  await expect(
    send(async () => {
      state.sent = 2
      return true
    }),
  ).rejects.toThrow(/session send cap reached/)
  expect(events).not.toContain('download')
})

it('while one dialog is open, a second send is refused instead of opening another', async () => {
  const { state, send } = harness()
  let answer: (accepted: boolean) => void = () => {}
  const first = send(() => new Promise((resolve) => (answer = resolve)))
  await new Promise((resolve) => setImmediate(resolve))

  await expect(send(async () => true)).rejects.toThrow(/waiting for the account owner/)
  answer(false)
  await expect(first).rejects.toThrow(/did not accept/)
  expect(state.confirming).toBe(false)
})

it('an attachment that cannot be described closes the dialog slot without asking', async () => {
  const { state, send } = harness()
  let asked = 0
  const confirm = async () => {
    asked += 1
    return true
  }
  const missing = { ...ARGS, attachments: [{ ...REF, partId: '9' }] }
  await expect(send(confirm, missing)).rejects.toMatchObject({ code: 'not_found' })
  expect(asked).toBe(0)
  expect(state.confirming).toBe(false)
})

it('the CoreApi seam hands the confirmation through to core', async () => {
  const { client } = harness()
  const core = makeCoreApi(cfg, fakeSession(client))
  await expect(core.sendEmail({ ...ARGS, attachments: [] }, async () => false)).rejects.toThrow(/did not accept/)
})

it('the proposal names the account it sends from', async () => {
  const { client } = harness()
  let shown: SendProposal | undefined
  await sendEmail(
    fakeSession(client),
    { ...cfg, account: 'work' },
    new SendState(),
    ARGS,
    new ComposeBudget(),
    async (proposal) => {
      shown = proposal
      return false
    },
  ).catch(() => undefined)
  expect(shown?.account).toBe('work')
})
