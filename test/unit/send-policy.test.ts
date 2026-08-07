import { expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import type { ImapSession } from '../../src/core/client.js'
import { SendState, checkAllowlist, sendEmail } from '../../src/core/smtp.js'
import { sendPolicyClause } from '../../src/mcp/tools/send.js'

it.each([
  [['a@x.example'], ['a@x.example'], []],
  [['A@X.example'], ['a@x.example'], []],
  [['b@x.example'], ['a@x.example'], ['b@x.example']],
  [['a@corp.example'], ['*@corp.example'], []],
  [['a@evil.example'], ['*@corp.example'], ['a@evil.example']],
  [['a@subcorp.example'], ['*@corp.example'], ['a@subcorp.example']], // no substring tricks
  [['a@x.example', 'b@y.example'], ['*'], []],
  [['a@x.example'], ['b@y.example', '*'], []], // * works wherever it sits in the list
])('recipients %j vs allowlist %j → rejected %j', (recipients, allowlist, rejected) => {
  expect(checkAllowlist(recipients, allowlist)).toEqual(rejected)
})

// config.ts builds the list with split/trim/filter(Boolean), so SEND_ALLOWLIST=""
// and SEND_ALLOWLIST=" , " both arrive here as [] rather than undefined
it('an allowlist that was set but is empty rejects every recipient', () => {
  expect(checkAllowlist(['a@x.example'], [])).toEqual(['a@x.example'])
})

it('rejected addresses come back exactly as the caller wrote them', () => {
  expect(checkAllowlist(['B@X.Example'], ['a@x.example'])).toEqual(['B@X.Example'])
})

it('a recipient with no domain never matches a wildcard pattern', () => {
  expect(checkAllowlist(['corp.example'], ['*@corp.example'])).toEqual(['corp.example'])
})

it('a wildcard matches on the last @ only, so an address-in-local-part cannot borrow a domain', () => {
  expect(checkAllowlist(['"a@corp.example"@evil.example'], ['*@corp.example'])).toEqual([
    '"a@corp.example"@evil.example',
  ])
})

it('every recipient outside the allowlist is reported, not just the first', () => {
  expect(checkAllowlist(['a@x.example', 'b@y.example', 'c@z.example'], ['a@x.example'])).toEqual([
    'b@y.example',
    'c@z.example',
  ])
})

it('a plain pattern matches the whole address, never a suffix of one', () => {
  expect(checkAllowlist(['evil-a@x.example'], ['a@x.example'])).toEqual(['evil-a@x.example'])
})

// sendEmail throws both policy refusals before touching the session, the
// attachments or the network, so nothing here opens a socket
const session = {} as ImapSession

function sendConfig(sendAllowlist: string[] | undefined) {
  return loadConfig({
    EMAIL_USER: 'owner@x.example',
    EMAIL_PASSWORD: 'pw',
    IMAP_HOST: 'localhost',
    CAPABILITIES: 'send',
    SMTP_HOST: 'localhost',
    DOWNLOAD_DIR: '/tmp',
    SEND_ALLOWLIST: sendAllowlist?.join(','),
  })
}

it('with no allowlist configured, sending is closed and the refusal teaches both fixes', async () => {
  await expect(
    sendEmail(session, sendConfig(undefined), new SendState(), {
      to: ['a@x.example'],
      subject: 's',
      body: 'b',
    }),
  ).rejects.toThrow(/sending is closed.*SEND_ALLOWLIST=\*/s)
})

it('a blocked recipient is named and the refusal shows how to widen the list', async () => {
  await expect(
    sendEmail(session, sendConfig(['a@x.example']), new SendState(), {
      to: ['b@y.example'],
      subject: 's',
      body: 'b',
    }),
  ).rejects.toThrow(/b@y\.example.*SEND_ALLOWLIST=\*/s)
})

// the description is the model's only view of the policy
it('the tool description states the policy in force', () => {
  expect(sendPolicyClause(undefined)).toMatch(/closed/)
  expect(sendPolicyClause(['*'])).toMatch(/any recipient/)
  expect(sendPolicyClause(['a@x.example'])).toMatch(/SEND_ALLOWLIST/)
})
