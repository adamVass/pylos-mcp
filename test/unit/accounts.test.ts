import { describe, expect, it } from 'vitest'
import { loadAccounts } from '../../src/accounts.js'
import { ConfigError, loadConfig } from '../../src/config.js'
import { openAccounts } from '../../src/core/api.js'

const TWO = {
  ACCOUNTS: 'personal, work',
  PROVIDER__PERSONAL: 'gmail',
  EMAIL_USER__PERSONAL: 'me@gmail.example',
  EMAIL_PASSWORD__PERSONAL: 'pw1',
  CAPABILITIES__PERSONAL: 'drafts,send',
  SEND_ALLOWLIST__PERSONAL: '*@family.example',
  EMAIL_USER__WORK: 'me@work.example',
  EMAIL_PASSWORD__WORK: 'pw2',
  IMAP_HOST__WORK: 'imap.work.example',
  CAPABILITIES__WORK: 'read',
  MAX_BODY_KB: '32',
}

const SINGLE = { EMAIL_USER: 'a@mailbox.org', EMAIL_PASSWORD: 'pw', PROVIDER: 'mailbox.org' }

const { EMAIL_USER__PERSONAL: _p, ...noPersonalUser } = TWO
const { EMAIL_USER__WORK: _w, ...noWorkUser } = TWO
const { EMAIL_PASSWORD__WORK: _pw, ...noWorkPassword } = TWO
const { IMAP_HOST__WORK: _h, ...noWorkHost } = TWO
const { EMAIL_PASSWORD__PERSONAL: _pp, ...noPasswords } = noWorkPassword

const WORK_USER_REQUIRED = 'account "work": EMAIL_USER is required. Its account settings end in __WORK'
const SEND_ALLOWLIST_BARE =
  "SEND_ALLOWLIST is set without an account suffix. With ACCOUNTS set, every account setting ends in __ and the account's name, such as SEND_ALLOWLIST__PERSONAL"
const BODY_SUFFIXED = 'MAX_BODY_KB__WORK: MAX_BODY_KB applies to all accounts. Drop the suffix'
const badName = (n: string) => `ACCOUNTS entry "${n}" must be 1 to 16 lowercase letters or digits`

describe('loadAccounts', () => {
  it('a two-account environment parses into one config per account', () => {
    const accounts = loadAccounts(TWO)
    expect(accounts.map((a) => a.name)).toEqual(['personal', 'work'])
    expect(accounts.map((a) => a.cfg.account)).toEqual(['personal', 'work'])
    expect(accounts.map((a) => a.cfg.user)).toEqual(['me@gmail.example', 'me@work.example'])
    expect(accounts.map((a) => a.cfg.imap.host)).toEqual(['imap.gmail.com', 'imap.work.example'])
    expect(accounts.map((a) => a.cfg.sendAllowlist)).toEqual([['*@family.example'], undefined])
    expect(accounts.map((a) => a.cfg.password)).toEqual(['pw1', 'pw2'])
    expect(accounts.map((a) => a.cfg.maxBodyKb)).toEqual([32, 32])
  })

  it('without ACCOUNTS the environment loads as one unnamed account', () => {
    expect(loadAccounts(SINGLE)).toEqual([{ cfg: loadConfig(SINGLE) }])
  })

  it('unrelated variables with a double underscore are ignored', () => {
    expect(loadAccounts({ ...TWO, MY_TOOL__HOME: 'x' })).toHaveLength(2)
    expect(loadAccounts({ ...SINGLE, MY_TOOL__HOME: 'x' })).toHaveLength(1)
  })

  it.each([
    [
      'single mode with a suffixed key',
      { ...SINGLE, EMAIL_USER__WORK: 'x' },
      'EMAIL_USER__WORK is set, but ACCOUNTS is not. Set ACCOUNTS to configure several accounts, or drop the suffix',
    ],
    [
      'a suffixed global key in single mode',
      { ...SINGLE, SEND_SESSION_CAP__WORK: '3' },
      'SEND_SESSION_CAP__WORK: SEND_SESSION_CAP applies to all accounts. Drop the suffix',
    ],
    ['a per-account key without a suffix', { ...TWO, SEND_ALLOWLIST: '*' }, SEND_ALLOWLIST_BARE],
    [
      'an unsuffixed key, named after the first account',
      { ACCOUNTS: 'home,office', SEND_ALLOWLIST: '*' },
      "SEND_ALLOWLIST is set without an account suffix. With ACCOUNTS set, every account setting ends in __ and the account's name, such as SEND_ALLOWLIST__HOME",
    ],
    [
      'a suffix naming no account',
      { ...TWO, CAPABILITIES__Work: 'read' },
      'CAPABILITIES__Work names no account in ACCOUNTS',
    ],
    [
      'a suffixed global key',
      { ...TWO, SEND_SESSION_CAP__WORK: '3' },
      'SEND_SESSION_CAP__WORK: SEND_SESSION_CAP applies to all accounts. Drop the suffix',
    ],
    ['an uppercase name', { ACCOUNTS: 'Work' }, badName('Work')],
    ['a hyphenated name', { ACCOUNTS: 'my-work' }, badName('my-work')],
    ['an empty entry', { ACCOUNTS: 'personal,,work' }, badName('')],
    ['a repeated name', { ACCOUNTS: 'work,work' }, 'ACCOUNTS names "work" twice'],
    [
      'too many accounts',
      { ACCOUNTS: Array.from({ length: 11 }, (_, i) => `a${i + 1}`).join(',') },
      'ACCOUNTS names 11 accounts, at most 10 are supported',
    ],
    ['a missing user', { ...TWO, EMAIL_USER__WORK: '' }, WORK_USER_REQUIRED],
    [
      'the same mailbox twice',
      { ...noWorkHost, EMAIL_USER__WORK: 'ME@gmail.example', PROVIDER__WORK: 'gmail' },
      'accounts "personal" and "work" are the same mailbox: the same EMAIL_USER on the same IMAP host',
    ],
    [
      'one Microsoft login twice, even on another IMAP host',
      {
        ...noPasswords,
        PROVIDER__PERSONAL: 'outlook',
        PROVIDER__WORK: 'outlook',
        EMAIL_USER__WORK: 'ME@gmail.example',
      },
      'accounts "personal" and "work" sign in to Microsoft with the same EMAIL_USER',
    ],
    [
      'a failing password command',
      { ...noWorkPassword, EMAIL_PASSWORD_CMD__WORK: 'exit 1' },
      'account "work": EMAIL_PASSWORD_CMD failed. Its account settings end in __WORK',
    ],
  ])('refuses %s', (_label, env, message) => {
    expect(() => loadAccounts(env)).toThrow(new ConfigError(message))
  })

  it('every problem is reported in one error', () => {
    const env = { ...TWO, ACCOUNTS: 'personal,work,x-y', SEND_ALLOWLIST: '*', MAX_BODY_KB__WORK: '8' }
    expect(() => loadAccounts(env)).toThrow(
      new ConfigError([badName('x-y'), SEND_ALLOWLIST_BARE, BODY_SUFFIXED].join('\n')),
    )
  })

  it('two broken accounts are both reported', () => {
    const { EMAIL_USER__WORK: _, ...neither } = noPersonalUser
    expect(() => loadAccounts(neither)).toThrow(
      new ConfigError(
        ['account "personal": EMAIL_USER is required. Its account settings end in __PERSONAL', WORK_USER_REQUIRED].join(
          '\n',
        ),
      ),
    )
  })

  it('every account is checked before any password command runs', () => {
    const { EMAIL_PASSWORD__PERSONAL: _, ...rest } = noWorkUser
    const env = { ...rest, EMAIL_PASSWORD_CMD__PERSONAL: 'exit 1' }
    expect(() => loadAccounts(env)).toThrow(new ConfigError(WORK_USER_REQUIRED))
  })
})

describe('openAccounts', () => {
  it('keeps each account to its own tiers', async () => {
    const { accounts, close } = openAccounts(loadAccounts(TWO))
    try {
      const work = accounts.find((a) => a.name === 'work')!
      await expect(work.core.createDraft({ to: ['a@x.example'], subject: 's', body: 'b' })).rejects.toThrow(
        'capability not enabled',
      )
    } finally {
      await close()
    }
  })
})
