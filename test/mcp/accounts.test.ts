import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { loadAccounts } from '../../src/accounts.js'
import type { CoreApi } from '../../src/core/api.js'
import { ToolError } from '../../src/errors.js'
import { buildServer } from '../../src/mcp/server.js'
import { type Calls, fakeCore } from './fake-core.js'

const ENV = {
  ACCOUNTS: 'personal,work',
  EMAIL_USER__PERSONAL: 'me@x.example',
  EMAIL_PASSWORD__PERSONAL: 'pw',
  IMAP_HOST__PERSONAL: 'localhost',
  CAPABILITIES__PERSONAL: 'drafts,send',
  SMTP_HOST__PERSONAL: 'localhost',
  SEND_ALLOWLIST__PERSONAL: '*',
  EMAIL_USER__WORK: 'me@work.example',
  EMAIL_PASSWORD__WORK: 'pw',
  IMAP_HOST__WORK: 'localhost',
  CAPABILITIES__WORK: 'read',
}

const EVERY_TIER = 'drafts,manage,delete,send,sieve-read'
const FULL = {
  ...ENV,
  CAPABILITIES__PERSONAL: EVERY_TIER,
  CAPABILITIES__WORK: EVERY_TIER,
  SMTP_HOST__WORK: 'localhost',
  SEND_ALLOWLIST__WORK: '*',
}

const openClients: Client[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

async function startServer(
  env: Record<string, string>,
  overrides: Record<string, Partial<CoreApi>> = {},
): Promise<{ client: Client; calls: Record<string, Calls> }> {
  const calls: Record<string, Calls> = { personal: {}, work: {} }
  const accounts = loadAccounts(env).map(({ name, cfg }) => ({
    name,
    cfg,
    core: { ...fakeCore(calls[name as string]), ...overrides[name as string] },
  }))
  const server = buildServer(accounts)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  openClients.push(client)
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, calls }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = (result.content as { type: string; text: string }[]).map((part) => part.text).join('\n')
  return { text, isError: result.isError === true }
}

type Schema = { properties: Record<string, { enum?: string[]; description?: string }>; required?: string[] }

async function schemas(client: Client): Promise<Map<string, Schema>> {
  return new Map((await client.listTools()).tools.map((tool) => [tool.name, tool.inputSchema as Schema]))
}

it('each tool lists only the accounts with its tier', async () => {
  const { client } = await startServer(ENV)
  const byName = await schemas(client)

  expect(byName.get('send_email')?.properties.account.enum).toEqual(['personal'])
  expect(byName.get('get_email')?.properties.account.enum).toEqual(['personal', 'work'])
  expect(byName.get('send_email')?.required).toContain('account')
  expect(byName.get('get_email')?.required).toContain('account')
  expect(byName.has('move_email')).toBe(false)
})

it('the account parameter names each login and its tiers', async () => {
  const { client } = await startServer(ENV)
  expect((await schemas(client)).get('get_email')?.properties.account.description).toBe(
    'Which mailbox to use: personal (me@x.example: read, drafts, send) or work (me@work.example: read).',
  )
})

it.each([
  ['search_emails', {}, 'searchEmails'],
  ['get_email', { folder: 'INBOX', uid: 7 }, 'getEmail'],
  ['get_thread', { folder: 'INBOX', uid: 7 }, 'getThread'],
  ['get_attachment', { folder: 'INBOX', uid: 7, part_id: '2' }, 'getAttachment'],
  ['list_folders', {}, 'listFolders'],
  ['create_draft', { subject: 's', body: 'b' }, 'createDraft'],
  ['move_email', { folder: 'INBOX', uid: 7, destination: 'Archive' }, 'moveEmail'],
  ['set_flags', { folder: 'INBOX', uid: 7, seen: true }, 'setFlags'],
  ['delete_email', { folder: 'INBOX', uid: 7 }, 'deleteEmail'],
  ['send_email', { to: ['a@x.example'], subject: 's', body: 'b' }, 'sendEmail'],
  ['list_sieve_scripts', {}, 'listSieveScripts'],
  ['get_sieve_script', { name: 'filters' }, 'getSieveScript'],
])('%s reaches only the named account and says which', async (tool, args, method) => {
  const { client, calls } = await startServer(FULL)
  const { text } = await call(client, tool, { ...args, account: 'work' })

  expect(calls.work[method]).toBeDefined()
  expect(calls.personal).toEqual({})
  expect(text.startsWith('Account: work\n')).toBe(true)
})

it.each([
  ['a tool error', new ToolError('not_found', 'message not found'), 'message not found'],
  ['an internal error', new Error('raw server text'), 'internal error. See server log'],
])('%s names the account and its settings suffix', async (_label, error, message) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { client } = await startServer(ENV, {
    work: {
      async getEmail() {
        throw error
      },
    },
  })
  const { text, isError } = await call(client, 'get_email', { account: 'work', folder: 'INBOX', uid: 7 })

  expect(isError).toBe(true)
  expect(text).toBe(`Account: work (its account settings end in __WORK)\n${message}`)
})

it('an account without the tier is refused before any core is called', async () => {
  const { client, calls } = await startServer(ENV)
  const { isError } = await call(client, 'send_email', {
    account: 'work',
    to: ['a@x.example'],
    subject: 's',
    body: 'b',
  })

  expect(isError).toBe(true)
  expect(calls.work.sendEmail).toBeUndefined()
  expect(calls.personal.sendEmail).toBeUndefined()
})

it('a call without an account is refused', async () => {
  const { client, calls } = await startServer(ENV)
  const { isError } = await call(client, 'get_email', { folder: 'INBOX', uid: 7 })

  expect(isError).toBe(true)
  expect(calls).toEqual({ personal: {}, work: {} })
})

it("send_email states the shared cap and each sending account's policy", async () => {
  const { client } = await startServer(ENV)
  const { tools } = await client.listTools()
  const description = tools.find((tool) => tool.name === 'send_email')?.description

  expect(description).toContain('At most 5 messages can be sent per server session, across all accounts.')
  expect(description).toContain('From personal, the account owner has allowed sending to any recipient.')
})

it('the send result counts across all accounts', async () => {
  const { client } = await startServer(ENV)
  const { text } = await call(client, 'send_email', {
    account: 'personal',
    to: ['a@x.example'],
    subject: 's',
    body: 'b',
  })

  expect(text).toContain('(2 of 5 session sends used, across all accounts).')
})
