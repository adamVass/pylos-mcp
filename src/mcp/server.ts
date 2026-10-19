import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Capability } from '../config.js'
import type { Account } from '../core/api.js'
import { eligible } from './accounts.js'
import { registerDeleteTools } from './tools/delete.js'
import { registerDraftTools } from './tools/drafts.js'
import { registerManageTools } from './tools/manage.js'
import { registerReadTools } from './tools/read.js'
import { registerSendTools } from './tools/send.js'
import { registerSieveTools } from './tools/sieve.js'

// two levels up from both src/ and dist/
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string; description: string }

const SERVER_INFO = {
  name: 'pylos-mcp',
  version: packageJson.version,
  description: packageJson.description,
  websiteUrl: 'https://github.com/adamVass/pylos-mcp',
  icons: [
    {
      src: 'https://raw.githubusercontent.com/adamVass/pylos-mcp/main/icon.png',
      mimeType: 'image/png',
      sizes: ['512x512'],
    },
  ],
}

const TIERS: [Capability, (server: McpServer, accounts: Account[]) => void][] = [
  ['read', registerReadTools],
  ['drafts', registerDraftTools],
  ['manage', registerManageTools],
  ['delete', registerDeleteTools],
  ['send', registerSendTools],
  ['sieve-read', registerSieveTools],
]

// a tier no account enables is never registered, so the model cannot be argued into calling it
export function buildServer(accounts: Account[]): McpServer {
  const server = new McpServer(SERVER_INFO)
  for (const [tier, register] of TIERS) {
    const tierAccounts = eligible(accounts, tier)
    if (tierAccounts.length > 0) register(server, tierAccounts)
  }
  return server
}
