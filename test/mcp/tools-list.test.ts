import { expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../../src/config.js'
import type { CoreApi } from '../../src/core/api.js'
import { buildServer } from '../../src/mcp/server.js'

const BASE_ENV = { EMAIL_USER: 'tester@example.com', EMAIL_PASSWORD: 'pw', IMAP_HOST: 'localhost' }

const throwingCore = (): CoreApi =>
  new Proxy({} as CoreApi, {
    get: (_target, method) => () => {
      throw new Error(`listing tools must not call core.${String(method)}`)
    },
  })

async function listedTools(env: Record<string, string>) {
  const server = buildServer([{ cfg: loadConfig({ ...BASE_ENV, ...env }), core: throwingCore() }])
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const { tools } = await client.listTools()
    return [...tools].sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    await client.close()
  }
}

it('single mode lists the default tools exactly as 1.2 did', async () => {
  expect(await listedTools({})).toMatchSnapshot()
})

it('single mode lists every tier exactly as 1.2 did', async () => {
  const env = {
    CAPABILITIES: 'drafts,manage,delete,send,sieve-read',
    SMTP_HOST: 'localhost',
    SEND_ALLOWLIST: 'a@x.example',
  }
  expect(await listedTools(env)).toMatchSnapshot()
})
