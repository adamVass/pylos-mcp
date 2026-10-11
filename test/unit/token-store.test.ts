import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defaultTokenDir, readToken, tokenPath, writeToken, type StoredToken } from '../../src/core/token-store.js'

const IMAP = 'https://outlook.office.com/IMAP.AccessAsUser.All'
const SMTP = 'https://outlook.office.com/SMTP.Send'

const TOKEN: StoredToken = {
  version: 1,
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'common',
  scopes: ['offline_access', IMAP],
  refreshToken: 'rt-1',
}
const WANT = { clientId: TOKEN.clientId, tenant: TOKEN.tenant, scopes: TOKEN.scopes }

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pylos-tokens-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('stores the token readable by its owner only, through a rename that leaves no temp file', async () => {
  const file = tokenPath(join(dir, 'nested'), 'jane@outlook.example')
  await writeToken(file, TOKEN)
  expect(await readdir(join(dir, 'nested'))).toEqual([basename(file)])
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readToken(file, WANT)).toEqual(TOKEN)
})

it('names the file after a hash of the lowercased address', () => {
  expect(tokenPath('/d', 'Jane@Outlook.example')).toBe(tokenPath('/d', 'jane@outlook.example'))
  expect(basename(tokenPath('/d', 'jane@outlook.example'))).toMatch(/^microsoft-[0-9a-f]{16}\.json$/)
})

// a grant made before `send` was enabled lacks SMTP.Send, and must lead to a
// fresh sign-in rather than a send that fails at the relay
it.each([
  ['another client', { ...WANT, clientId: '99999999-2222-3333-4444-555555555555' }],
  ['another tenant', { ...WANT, tenant: 'contoso.example' }],
  ['a scope the grant lacks', { ...WANT, scopes: [...WANT.scopes, SMTP] }],
])('reads a token for %s as no token', async (_case, want) => {
  const file = tokenPath(dir, 'jane@outlook.example')
  await writeToken(file, TOKEN)
  expect(await readToken(file, want)).toBeUndefined()
})

it('reads a missing or unparseable file as no token', async () => {
  const file = tokenPath(dir, 'jane@outlook.example')
  expect(await readToken(file, WANT)).toBeUndefined()
  await writeFile(file, 'not json')
  expect(await readToken(file, WANT)).toBeUndefined()
})

it('keeps the token where each platform keeps app settings', () => {
  expect(defaultTokenDir('darwin', {}, '/Users/j')).toBe(
    join('/Users/j', 'Library', 'Application Support', 'pylos-mcp'),
  )
  expect(defaultTokenDir('win32', { APPDATA: 'C:\\Roaming' }, '/h')).toBe(join('C:\\Roaming', 'pylos-mcp'))
  expect(defaultTokenDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe(join('/x', 'pylos-mcp'))
  expect(defaultTokenDir('linux', {}, '/h')).toBe(join('/h', '.config', 'pylos-mcp'))
})
