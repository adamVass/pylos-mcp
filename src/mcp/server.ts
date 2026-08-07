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

// package.json sits two directories up from this file both in src/ (run directly
// by the test loader) and in dist/ (compiled), since rootDir and outDir are one
// level below the package root either way.
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
const SERVER_VERSION = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version

/**
 * A capability that is off has its tools NEVER REGISTERED: they are absent from
 * tools/list rather than refused when called. A tool the model cannot see is one
 * it cannot be argued into attempting.
 */
export function buildServer(cfg: Config, core: CoreApi): McpServer {
  const server = new McpServer({ name: 'pylos-mcp', version: SERVER_VERSION })

  registerReadTools(server, cfg, core)
  if (cfg.capabilities.has('drafts')) registerDraftTools(server, cfg, core)
  if (cfg.capabilities.has('manage')) registerManageTools(server, cfg, core)
  if (cfg.capabilities.has('delete')) registerDeleteTools(server, cfg, core)
  if (cfg.capabilities.has('send')) registerSendTools(server, cfg, core)
  if (cfg.capabilities.has('sieve-read')) registerSieveTools(server, cfg, core)

  return server
}
