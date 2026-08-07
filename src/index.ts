#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig, type Config } from './config.js'
import { makeCoreApi } from './core/api.js'
import { ImapSession } from './core/client.js'
import { buildServer } from './mcp/server.js'

/**
 * Config errors are the only fatal ones, and this exits before an ImapSession or
 * transport exists, so a bad config never opens a socket.
 */
function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('pylos-mcp: ' + err.message)
      process.exit(1)
    }
    throw err
  }
}

async function main(): Promise<void> {
  const cfg = loadConfigOrExit()

  // Exactly one ImapSession/CoreApi for the process: the send tier's session
  // cap and the IMAP connection's single-connection design both assume it.
  const session = new ImapSession(cfg)
  const core = makeCoreApi(cfg, session)
  const server = buildServer(cfg, core)

  const shutdown = (): void => {
    session.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  // stdout carries MCP protocol frames exclusively, so every diagnostic in this
  // codebase goes to stderr
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('pylos-mcp: unexpected error', err)
  process.exit(1)
})
