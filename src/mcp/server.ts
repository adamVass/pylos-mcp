import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from '../config.js'
import type { CoreApi } from '../core/api.js'
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

// a disabled capability's tools are never registered, so the model cannot be argued into calling them
export function buildServer(cfg: Config, core: CoreApi): McpServer {
  const server = new McpServer(SERVER_INFO)

  registerReadTools(server, cfg, core)
  if (cfg.capabilities.has('drafts')) registerDraftTools(server, cfg, core)
  if (cfg.capabilities.has('manage')) registerManageTools(server, core)
  if (cfg.capabilities.has('delete')) registerDeleteTools(server, core)
  if (cfg.capabilities.has('send')) registerSendTools(server, cfg, core)
  if (cfg.capabilities.has('sieve-read')) registerSieveTools(server, cfg, core)

  return server
}
